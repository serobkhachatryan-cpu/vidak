import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@w3ds/auth';
import { getW3dsDatabase } from './db/client';
import { MediaAssetError } from './media-asset-errors';
import {
  type MediaAsset,
  type MediaAssetStore,
  PostgresMediaAssetStore,
} from './media-asset-store';
import {
  contentRangeHeader,
  parseSingleByteRange,
  unsatisfiableContentRangeHeader,
} from './media-byte-range';
import {
  isThumbnailMediaContentType,
  type MediaUploadLimits,
  normalizeContentType,
  resolveMediaUploadLimits,
  resolveThumbnailUploadLimits,
  type ThumbnailUploadLimits,
} from './media-limits';
import {
  LocalDiskMediaStorage,
  type MediaStorage,
  MediaStorageError,
  resolveLocalMediaStorageRoot,
} from './media-storage';
import { reportOperationalFailure } from './ops-observability';
import { getW3dsAuthService, W3dsAuthError } from './w3ds-auth';

export { MediaAssetError } from './media-asset-errors';
export type { MediaAsset, MediaAssetStore } from './media-asset-store';
export { InMemoryMediaAssetStore, PostgresMediaAssetStore } from './media-asset-store';
export {
  DEFAULT_ALLOWED_MEDIA_CONTENT_TYPES,
  DEFAULT_ALLOWED_THUMBNAIL_CONTENT_TYPES,
  DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
  DEFAULT_MAX_THUMBNAIL_UPLOAD_BYTES,
  resolveMediaUploadLimits,
  resolveThumbnailUploadLimits,
} from './media-limits';
export type { MediaStorage } from './media-storage';
export { LocalDiskMediaStorage, resolveLocalMediaStorageRoot } from './media-storage';

/**
 * Wire-safe media asset projection. Omits storage keys and any filesystem
 * paths — clients never receive private blob addresses or public URLs.
 */
export type PublicMediaAsset = Omit<MediaAsset, 'storageKey'>;

export interface MediaAssetDownload {
  asset: PublicMediaAsset;
  body: ReadableStream<Uint8Array>;
  status: number;
  headers: {
    'Content-Type': string;
    'Content-Length': string;
    'Content-Disposition': string;
    'Cache-Control': string;
    'X-Content-Type-Options': string;
    'Accept-Ranges'?: string;
    'Content-Range'?: string;
  };
}

export interface MediaUploadHeaders {
  contentType: string | null;
  contentLength: string | null;
  originalFilename: string | null;
}

export interface MediaAssetServiceOptions {
  store: MediaAssetStore;
  storage: MediaStorage;
  limits?: MediaUploadLimits;
  thumbnailLimits?: ThumbnailUploadLimits;
  /**
   * Resolves the authenticated platform user from an access token.
   * Defaults to the shared W3DS auth service.
   */
  resolveUser?: (accessToken: string) => Promise<AuthUser>;
  createId?: () => string;
}

/**
 * Authenticated media transfer service for draft-owned private assets.
 * Uploads stream into temporary private storage, then finalize + mark ready.
 */
export class MediaAssetService {
  private readonly store: MediaAssetStore;
  private readonly storage: MediaStorage;
  private readonly limits: MediaUploadLimits;
  private readonly thumbnailLimits: ThumbnailUploadLimits;
  private readonly resolveUser: (accessToken: string) => Promise<AuthUser>;
  private readonly createId: () => string;

  constructor(options: MediaAssetServiceOptions) {
    this.store = options.store;
    this.storage = options.storage;
    this.limits = options.limits ?? resolveMediaUploadLimits();
    this.thumbnailLimits = options.thumbnailLimits ?? resolveThumbnailUploadLimits();
    this.resolveUser =
      options.resolveUser ??
      (async (accessToken) => {
        const session = await getW3dsAuthService().getSession(accessToken);
        return session.user;
      });
    this.createId = options.createId ?? (() => randomUUID());
  }

  /**
   * Streams an authenticated raw-body upload into an owned draft.
   * Atomic lifecycle: validate → temp write → finalize → ready; cleanup on failure.
   */
  async uploadToDraft(
    accessToken: string,
    videoId: string,
    headers: MediaUploadHeaders,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PublicMediaAsset> {
    const user = await this.requireUser(accessToken);
    const draftId = videoId.trim();
    if (!draftId) {
      throw new MediaAssetError('Video draft was not found.', 'not_found', 404);
    }

    const contentType = normalizeContentType(headers.contentType);
    if (!contentType) {
      throw new MediaAssetError('Content-Type is required.', 'validation_failed', 400);
    }
    if (!this.limits.allowedContentTypes.includes(contentType)) {
      throw new MediaAssetError(
        'Content-Type is not allowed for media uploads.',
        'unsupported_media_type',
        415,
      );
    }

    const declaredSize = parseContentLength(headers.contentLength);
    if (declaredSize === undefined) {
      throw new MediaAssetError(
        'Content-Length is required and must be a non-negative integer.',
        'validation_failed',
        400,
      );
    }
    if (declaredSize > this.limits.maxUploadBytes) {
      throw new MediaAssetError(
        `Upload exceeds the maximum size of ${this.limits.maxUploadBytes} bytes.`,
        'payload_too_large',
        413,
      );
    }

    const originalFilename = normalizeOriginalFilename(headers.originalFilename);
    if (!body) {
      throw new MediaAssetError('Request body is required.', 'validation_failed', 400);
    }

    const assetId = this.createId();
    const storageKey = this.storage.createStorageKey();
    let asset: MediaAsset | undefined;
    const upload = await this.storage.openUpload();
    let finalized = false;

    try {
      asset = await this.store.createAsset({
        id: assetId,
        ownerId: user.id,
        videoId: draftId,
        storageKey,
        originalFilename,
        contentType,
        byteSize: declaredSize,
        uploadState: 'uploading',
      });

      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const nextSize = upload.bytesWritten + value.byteLength;
          if (nextSize > this.limits.maxUploadBytes) {
            throw new MediaAssetError(
              `Upload exceeds the maximum size of ${this.limits.maxUploadBytes} bytes.`,
              'payload_too_large',
              413,
            );
          }
          if (nextSize > declaredSize) {
            throw new MediaAssetError(
              'Upload body exceeds the declared Content-Length.',
              'payload_too_large',
              413,
            );
          }
          await upload.write(value);
        }
      } finally {
        reader.releaseLock();
      }

      if (upload.bytesWritten !== declaredSize) {
        throw new MediaAssetError(
          'Upload body size does not match Content-Length.',
          'validation_failed',
          400,
        );
      }

      await upload.finalize(storageKey);
      finalized = true;

      const ready = await this.store.updateUploadState(asset.id, user.id, 'ready');
      if (!ready) {
        throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
      }
      return toPublicMediaAsset(ready);
    } catch (error) {
      await this.cleanupFailedUpload({
        upload: finalized ? undefined : upload,
        storageKey,
        assetId: asset?.id,
        ownerId: user.id,
      });
      if (error instanceof MediaAssetError || error instanceof W3dsAuthError) {
        throw error;
      }
      if (error instanceof MediaStorageError) {
        reportOperationalFailure({
          category: 'media_storage',
          error,
          code: error.code,
        });
        throw new MediaAssetError('Media storage is unavailable.', 'internal_error', 500);
      }
      reportOperationalFailure({
        category: 'media_storage',
        error,
        code: 'internal_error',
      });
      throw error;
    }
  }

  /**
   * Streams an authenticated raw-body thumbnail image into an owned draft.
   * Replaces any previous ready thumbnail image assets for the draft.
   */
  async uploadThumbnailToDraft(
    accessToken: string,
    videoId: string,
    headers: MediaUploadHeaders,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<PublicMediaAsset> {
    const user = await this.requireUser(accessToken);
    const draftId = videoId.trim();
    if (!draftId) {
      throw new MediaAssetError('Video draft was not found.', 'not_found', 404);
    }

    const contentType = normalizeContentType(headers.contentType);
    if (!contentType) {
      throw new MediaAssetError('Content-Type is required.', 'validation_failed', 400);
    }
    if (!this.thumbnailLimits.allowedContentTypes.includes(contentType)) {
      throw new MediaAssetError(
        'Content-Type is not allowed for thumbnail uploads.',
        'unsupported_media_type',
        415,
      );
    }

    const declaredSize = parseContentLength(headers.contentLength);
    if (declaredSize === undefined) {
      throw new MediaAssetError(
        'Content-Length is required and must be a non-negative integer.',
        'validation_failed',
        400,
      );
    }
    if (declaredSize > this.thumbnailLimits.maxUploadBytes) {
      throw new MediaAssetError(
        `Upload exceeds the maximum size of ${this.thumbnailLimits.maxUploadBytes} bytes.`,
        'payload_too_large',
        413,
      );
    }

    const originalFilename = normalizeOriginalFilename(headers.originalFilename);
    if (!body) {
      throw new MediaAssetError('Request body is required.', 'validation_failed', 400);
    }

    const previousThumbnails = (await this.store.listOwnedAssetsByVideoId(draftId, user.id)).filter(
      (asset) => isThumbnailMediaContentType(asset.contentType),
    );

    const assetId = this.createId();
    const storageKey = this.storage.createStorageKey();
    let asset: MediaAsset | undefined;
    const upload = await this.storage.openUpload();
    let finalized = false;

    try {
      asset = await this.store.createAsset({
        id: assetId,
        ownerId: user.id,
        videoId: draftId,
        storageKey,
        originalFilename,
        contentType,
        byteSize: declaredSize,
        uploadState: 'uploading',
      });

      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const nextSize = upload.bytesWritten + value.byteLength;
          if (nextSize > this.thumbnailLimits.maxUploadBytes) {
            throw new MediaAssetError(
              `Upload exceeds the maximum size of ${this.thumbnailLimits.maxUploadBytes} bytes.`,
              'payload_too_large',
              413,
            );
          }
          if (nextSize > declaredSize) {
            throw new MediaAssetError(
              'Upload body exceeds the declared Content-Length.',
              'payload_too_large',
              413,
            );
          }
          await upload.write(value);
        }
      } finally {
        reader.releaseLock();
      }

      if (upload.bytesWritten !== declaredSize) {
        throw new MediaAssetError(
          'Upload body size does not match Content-Length.',
          'validation_failed',
          400,
        );
      }

      await upload.finalize(storageKey);
      finalized = true;

      const ready = await this.store.updateUploadState(asset.id, user.id, 'ready');
      if (!ready) {
        throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
      }

      for (const previous of previousThumbnails) {
        const deleted = await this.store.deleteOwnedAsset(previous.id, user.id);
        if (deleted) {
          try {
            await this.storage.delete(deleted.storageKey);
          } catch {
            // Prefer orphaned private blobs over failing a successful thumbnail replace.
          }
        }
      }

      return toPublicMediaAsset(ready);
    } catch (error) {
      await this.cleanupFailedUpload({
        upload: finalized ? undefined : upload,
        storageKey,
        assetId: asset?.id,
        ownerId: user.id,
      });
      if (error instanceof MediaAssetError || error instanceof W3dsAuthError) {
        throw error;
      }
      if (error instanceof MediaStorageError) {
        reportOperationalFailure({
          category: 'media_storage',
          error,
          code: error.code,
        });
        throw new MediaAssetError('Media storage is unavailable.', 'internal_error', 500);
      }
      reportOperationalFailure({
        category: 'media_storage',
        error,
        code: 'internal_error',
      });
      throw error;
    }
  }

  async getOwnedAsset(
    accessToken: string,
    videoId: string,
    assetId: string,
  ): Promise<PublicMediaAsset> {
    const user = await this.requireUser(accessToken);
    const asset = await this.requireOwnedAssetForDraft(assetId, videoId, user.id);
    return toPublicMediaAsset(asset);
  }

  async openDownload(
    accessToken: string,
    videoId: string,
    assetId: string,
    options: { rangeHeader?: string | null } = {},
  ): Promise<MediaAssetDownload> {
    const user = await this.requireUser(accessToken);
    const asset = await this.requireOwnedAssetForDraft(assetId, videoId, user.id);
    if (asset.uploadState !== 'ready') {
      throw new MediaAssetError('Media asset is not ready for download.', 'not_found', 404);
    }
    return this.openReadyAssetStream(asset, {
      disposition: 'inline',
      ...(options.rangeHeader !== undefined ? { rangeHeader: options.rangeHeader } : {}),
      acceptRanges: true,
    });
  }

  /**
   * Anonymous stream for a ready asset attached to an already-validated
   * published public/unlisted video. Callers must resolve visibility first;
   * this method does not accept auth and never returns storage keys.
   */
  async openPublishedDownload(
    videoId: string,
    assetId: string,
    options: { rangeHeader?: string | null } = {},
  ): Promise<MediaAssetDownload> {
    const normalizedVideoId = videoId.trim();
    const normalizedAssetId = assetId.trim();
    if (!normalizedVideoId || !normalizedAssetId) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    const asset = await this.store.getReadyAssetForVideo(normalizedVideoId, normalizedAssetId);
    if (!asset) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    return this.openReadyAssetStream(asset, {
      disposition: 'inline',
      ...(options.rangeHeader !== undefined ? { rangeHeader: options.rangeHeader } : {}),
      acceptRanges: true,
    });
  }

  /**
   * Anonymous primary ready-asset stream for a published public/unlisted video.
   * Callers must resolve visibility first. Supports safe single byte ranges for
   * HTML5 seeking. Never returns storage keys, paths, or asset ids in headers.
   */
  async openPrimaryPublishedDownload(
    videoId: string,
    options: { rangeHeader?: string | null } = {},
  ): Promise<MediaAssetDownload> {
    const normalizedVideoId = videoId.trim();
    if (!normalizedVideoId) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    const asset = await this.store.getPrimaryReadyAssetForVideo(normalizedVideoId);
    if (!asset) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    return this.openReadyAssetStream(asset, {
      disposition: 'inline',
      ...(options.rangeHeader !== undefined ? { rangeHeader: options.rangeHeader } : {}),
      acceptRanges: true,
    });
  }

  /**
   * True when the video has at least one ready media asset (no ownership check).
   * Used only after published public/unlisted visibility is confirmed.
   */
  async hasPrimaryReadyAsset(videoId: string): Promise<boolean> {
    const asset = await this.store.getPrimaryReadyAssetForVideo(videoId.trim());
    return Boolean(asset);
  }

  /**
   * Browser-safe metadata for the primary published video asset.
   * Does not include storage keys, filesystem paths, or raw blob addresses.
   */
  async getPrimaryPublishedAsset(videoId: string): Promise<PublicMediaAsset | undefined> {
    const asset = await this.store.getPrimaryReadyAssetForVideo(videoId.trim());
    return asset ? toPublicMediaAsset(asset) : undefined;
  }

  /**
   * Browser-safe metadata for every ready video asset on a published video,
   * oldest first. Does not include storage keys, filesystem paths, or raw blob
   * addresses.
   */
  async listPublishedVideoAssets(videoId: string): Promise<PublicMediaAsset[]> {
    const assets = await this.store.listReadyVideoAssetsForVideo(videoId.trim());
    return assets.map(toPublicMediaAsset);
  }

  /** True when the video has a ready thumbnail image asset (no ownership check). */
  async hasReadyThumbnailAsset(videoId: string): Promise<boolean> {
    const asset = await this.store.getReadyThumbnailAssetForVideo(videoId.trim());
    return Boolean(asset);
  }

  /**
   * Authenticated stream for the newest ready thumbnail image on an owned draft.
   */
  async openOwnedThumbnailDownload(
    accessToken: string,
    videoId: string,
  ): Promise<MediaAssetDownload> {
    const user = await this.requireUser(accessToken);
    const normalizedVideoId = videoId.trim();
    if (!normalizedVideoId) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    const owned = await this.store.listOwnedAssetsByVideoId(normalizedVideoId, user.id);
    if (owned.length === 0) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    const asset = await this.store.getReadyThumbnailAssetForVideo(normalizedVideoId);
    if (!asset || asset.ownerId !== user.id) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    return this.openReadyAssetStream(asset, { disposition: 'inline' });
  }

  /**
   * Anonymous thumbnail stream for a published public/unlisted video.
   * Callers must resolve visibility first.
   */
  async openPublishedThumbnailDownload(videoId: string): Promise<MediaAssetDownload> {
    const normalizedVideoId = videoId.trim();
    if (!normalizedVideoId) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    const asset = await this.store.getReadyThumbnailAssetForVideo(normalizedVideoId);
    if (!asset) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    return this.openReadyAssetStream(asset, { disposition: 'inline' });
  }

  /**
   * Deletes the owned asset row, then best-effort removes the private blob.
   * Storage cleanup failures do not resurrect the database record.
   */
  async deleteOwnedAsset(accessToken: string, videoId: string, assetId: string): Promise<void> {
    const user = await this.requireUser(accessToken);
    await this.requireOwnedAssetForDraft(assetId, videoId, user.id);
    const deleted = await this.store.deleteOwnedAsset(assetId.trim(), user.id);
    if (!deleted) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    try {
      await this.storage.delete(deleted.storageKey);
    } catch {
      // Orphaned private blobs are preferable to failing a successful delete.
    }
  }

  private async requireUser(accessToken: string): Promise<AuthUser> {
    if (!accessToken.trim()) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    try {
      return await this.resolveUser(accessToken);
    } catch (error) {
      if (error instanceof W3dsAuthError) throw error;
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
  }

  private async requireOwnedAssetForDraft(
    assetId: string,
    videoId: string,
    ownerId: string,
  ): Promise<MediaAsset> {
    const normalizedAssetId = assetId.trim();
    const normalizedVideoId = videoId.trim();
    if (!normalizedAssetId || !normalizedVideoId) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    const asset = await this.store.getOwnedAsset(normalizedAssetId, ownerId);
    if (!asset || asset.videoId !== normalizedVideoId) {
      throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
    }
    return asset;
  }

  private async openReadyAssetStream(
    asset: MediaAsset,
    options: {
      disposition: 'attachment' | 'inline';
      rangeHeader?: string | null;
      acceptRanges?: boolean;
    },
  ): Promise<MediaAssetDownload> {
    const parsed = parseSingleByteRange(options.rangeHeader, asset.byteSize);
    if (parsed.kind === 'invalid') {
      throw new MediaAssetError('Range request is invalid.', 'validation_failed', 400);
    }
    if (parsed.kind === 'unsatisfiable') {
      throw new MediaAssetError(
        'Requested range is not satisfiable.',
        'range_not_satisfiable',
        416,
        {
          headers: {
            'Content-Range': unsatisfiableContentRangeHeader(asset.byteSize),
            'Accept-Ranges': 'bytes',
          },
        },
      );
    }

    const range = parsed.kind === 'range' ? { start: parsed.start, end: parsed.end } : undefined;
    let body: ReadableStream<Uint8Array>;
    try {
      body = await this.storage.openReadStream(asset.storageKey, range);
    } catch (error) {
      if (error instanceof MediaStorageError && error.code === 'not_found') {
        throw new MediaAssetError('Media asset was not found.', 'not_found', 404);
      }
      throw error;
    }

    const contentLength = range ? range.end - range.start + 1 : asset.byteSize;
    const headers: MediaAssetDownload['headers'] = {
      'Content-Type': asset.contentType,
      'Content-Length': String(contentLength),
      'Content-Disposition': contentDispositionHeader(asset.originalFilename, options.disposition),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (options.acceptRanges || range) {
      headers['Accept-Ranges'] = 'bytes';
    }
    if (range) {
      headers['Content-Range'] = contentRangeHeader(range.start, range.end, asset.byteSize);
    }

    return {
      asset: toPublicMediaAsset(asset),
      body,
      status: range ? 206 : 200,
      headers,
    };
  }

  private async cleanupFailedUpload(options: {
    upload: { abort: () => Promise<void> } | undefined;
    storageKey: string;
    assetId: string | undefined;
    ownerId: string;
  }): Promise<void> {
    if (options.upload) {
      await options.upload.abort().catch(() => undefined);
    }
    await this.storage.delete(options.storageKey).catch(() => undefined);
    if (options.assetId) {
      await this.store.deleteOwnedAsset(options.assetId, options.ownerId).catch(() => undefined);
    }
  }
}

export function toPublicMediaAsset(asset: MediaAsset): PublicMediaAsset {
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    videoId: asset.videoId,
    originalFilename: asset.originalFilename,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    uploadState: asset.uploadState,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function normalizeOriginalFilename(value: string | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new MediaAssetError('X-Original-Filename is required.', 'validation_failed', 400);
  }
  // Strip path segments from client-supplied names; retain basename only.
  const basename = trimmed.split(/[/\\]/).pop()?.trim() ?? '';
  if (!basename || basename === '.' || basename === '..') {
    throw new MediaAssetError('X-Original-Filename is invalid.', 'validation_failed', 400);
  }
  if (basename.length > 512) {
    throw new MediaAssetError(
      'Original filename must be 512 characters or fewer.',
      'validation_failed',
      400,
    );
  }
  return basename;
}

/** RFC 5987-ish safe Content-Disposition using a sanitized filename. */
export function contentDispositionHeader(
  originalFilename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const fallback = 'download';
  const ascii =
    originalFilename
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_')
      .trim() || fallback;
  const encoded = encodeURIComponent(originalFilename);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

let sharedService: MediaAssetService | undefined;

export function getMediaAssetService(): MediaAssetService {
  if (!sharedService) {
    sharedService = new MediaAssetService({
      store: new PostgresMediaAssetStore(getW3dsDatabase()),
      storage: new LocalDiskMediaStorage(resolveLocalMediaStorageRoot()),
      limits: resolveMediaUploadLimits(),
    });
  }
  return sharedService;
}

export function resetMediaAssetServiceForTests(): void {
  sharedService = undefined;
}
