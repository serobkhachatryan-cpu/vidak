import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@w3ds/auth';
import { isRenderableThumbnailUrl, normalizePersistedThumbnailUrl, type Video } from '@w3ds/types';
import { type CreatorVideoStore, PostgresCreatorVideoStore } from '../creator-video-store';
import { getW3dsDatabase } from '../db/client';
import type { VideoPreviewSourceKind, VideoPreviewStatus } from '../db/schema';
import { type MediaAssetStore, PostgresMediaAssetStore } from '../media-asset-store';
import {
  LocalDiskMediaStorage,
  type MediaStorage,
  resolveLocalMediaStorageRoot,
} from '../media-storage';
import { evaultVideoPreviewPath, ownedVideoPreviewPath } from './capture-time';
import {
  FfmpegVideoFrameExtractor,
  type PreviewFrameSource,
  type VideoFrameExtractor,
} from './frame-extractor';
import {
  PostgresVideoPreviewStore,
  type VideoPreviewRecord,
  type VideoPreviewStore,
} from './preview-store';

export type VideoPreviewState = 'ready' | 'processing' | 'unavailable';

export interface VideoPosterDescriptor {
  state: VideoPreviewState;
  posterUrl?: string;
}

export interface PreviewDownload {
  body: Uint8Array;
  contentType: string;
  status: 'ready';
}

export class VideoPreviewError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'authentication_required'
      | 'not_found'
      | 'forbidden'
      | 'processing'
      | 'unavailable'
      | 'internal_error',
    public readonly status: number,
  ) {
    super(message);
    this.name = 'VideoPreviewError';
  }
}

export interface AuthorizedEVaultPreviewSource {
  inspectStream(user: Pick<AuthUser, 'eName'>, streamId: string): { fileUri: string };
  resolveMediaUrl(user: Pick<AuthUser, 'eName'>, streamId: string): Promise<string>;
}

export interface VideoPreviewServiceOptions {
  store: VideoPreviewStore;
  storage: MediaStorage;
  videos: Pick<CreatorVideoStore, 'getOwnedVideo'>;
  media: Pick<MediaAssetStore, 'getReadyThumbnailAssetForVideo' | 'getPrimaryReadyAssetForVideo'>;
  extractor?: VideoFrameExtractor;
  evault?: AuthorizedEVaultPreviewSource;
  createId?: () => string;
}

const inFlight = new Set<string>();
const stalePendingMs = 2 * 60 * 1000;
const staleFailedMs = 60 * 60 * 1000;

export class VideoPreviewService {
  private readonly store: VideoPreviewStore;
  private readonly storage: MediaStorage;
  private readonly videos: Pick<CreatorVideoStore, 'getOwnedVideo'>;
  private readonly media: Pick<
    MediaAssetStore,
    'getReadyThumbnailAssetForVideo' | 'getPrimaryReadyAssetForVideo'
  >;
  private readonly extractor: VideoFrameExtractor;
  private readonly evault: AuthorizedEVaultPreviewSource | undefined;
  private readonly createId: () => string;

  constructor(options: VideoPreviewServiceOptions) {
    this.store = options.store;
    this.storage = options.storage;
    this.videos = options.videos;
    this.media = options.media;
    this.extractor = options.extractor ?? new FfmpegVideoFrameExtractor();
    this.evault = options.evault;
    this.createId = options.createId ?? (() => randomUUID());
  }

  describeOwnedPoster(video: Pick<Video, 'id' | 'thumbnailUrl'>): VideoPosterDescriptor {
    const existing = normalizePersistedThumbnailUrl(video.thumbnailUrl);
    if (existing && isRenderableThumbnailUrl(existing)) {
      return { state: 'ready', posterUrl: existing };
    }
    return { state: 'processing', posterUrl: ownedVideoPreviewPath(video.id) };
  }

  describeLibraryPoster(input: {
    streamIds?: readonly string[];
    previewState?: VideoPreviewState;
  }): VideoPosterDescriptor {
    const streamId = input.streamIds?.[0];
    if (!streamId) return { state: 'unavailable' };
    const posterUrl = evaultVideoPreviewPath(streamId);
    if (input.previewState === 'unavailable') return { state: 'unavailable', posterUrl };
    if (input.previewState === 'ready') return { state: 'ready', posterUrl };
    return { state: 'processing', posterUrl };
  }

  async peekLibraryPreview(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
  ): Promise<VideoPreviewState> {
    const fileUri = this.requireEVaultSource().inspectStream(user, streamId).fileUri;
    const record = await this.store.getBySource('evault-file', fileUri);
    // A failed record can be a transient W3DS/HTTP failure. Keep it in the
    // processing path so the visible-card queue can request a bounded retry.
    if (record?.status === 'failed') return 'processing';
    return statusToState(record?.status);
  }

  async scheduleOwnedBackfill(
    user: Pick<AuthUser, 'id'>,
    videos: ReadonlyArray<Pick<Video, 'id' | 'thumbnailUrl'>>,
  ): Promise<void> {
    for (const video of videos) {
      void this.ensureOwnedPreview(user, video.id).catch(() => undefined);
    }
  }

  async scheduleLibraryBackfill(
    user: Pick<AuthUser, 'eName'>,
    items: ReadonlyArray<{ streamIds?: readonly string[] }>,
  ): Promise<void> {
    for (const item of items) {
      const streamId = item.streamIds?.[0];
      if (!streamId) continue;
      void this.ensureEVaultPreview(user, streamId, { retryFailed: true }).catch(() => undefined);
    }
  }

  async openOwnedPreview(
    user: Pick<AuthUser, 'id'>,
    videoId: string,
  ): Promise<PreviewDownload | { status: 'processing' } | { status: 'unavailable' }> {
    const owned = await this.videos.getOwnedVideo(videoId.trim(), user.id);
    if (!owned) {
      throw new VideoPreviewError('Video was not found.', 'not_found', 404);
    }

    const thumbnail = await this.media.getReadyThumbnailAssetForVideo(owned.id);
    if (thumbnail && thumbnail.ownerId === user.id && thumbnail.storageKey) {
      const body = await this.storage.read(thumbnail.storageKey);
      return { status: 'ready', body, contentType: thumbnail.contentType || 'image/jpeg' };
    }

    const record = await this.ensureOwnedPreview(user, owned.id);
    return this.openRecord(record);
  }

  async openEVaultPreview(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
  ): Promise<PreviewDownload | { status: 'processing' } | { status: 'unavailable' }> {
    this.requireEVaultSource().inspectStream(user, streamId);
    const record = await this.ensureEVaultPreview(user, streamId, { retryFailed: true });
    return this.openRecord(record);
  }

  private async ensureOwnedPreview(
    user: Pick<AuthUser, 'id'>,
    videoId: string,
  ): Promise<VideoPreviewRecord> {
    const owned = await this.videos.getOwnedVideo(videoId, user.id);
    if (!owned) {
      throw new VideoPreviewError('Video was not found.', 'not_found', 404);
    }

    const thumbnail = await this.media.getReadyThumbnailAssetForVideo(owned.id);
    if (thumbnail && thumbnail.ownerId === user.id) {
      return {
        id: thumbnail.id,
        sourceKind: 'owned-video',
        sourceKey: owned.id,
        storageKey: thumbnail.storageKey,
        status: 'ready',
        contentType: thumbnail.contentType,
        byteSize: thumbnail.byteSize,
        createdAt: thumbnail.createdAt,
        updatedAt: thumbnail.updatedAt,
      };
    }

    return this.generate('owned-video', owned.id, async () => {
      const asset = await this.media.getPrimaryReadyAssetForVideo(owned.id);
      if (!asset || asset.ownerId !== user.id) return undefined;
      return this.sourceFromAsset(asset.storageKey);
    });
  }

  private async ensureEVaultPreview(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
    options?: { retryFailed?: boolean },
  ): Promise<VideoPreviewRecord> {
    const evault = this.requireEVaultSource();
    const { fileUri } = evault.inspectStream(user, streamId);
    return this.generate(
      'evault-file',
      fileUri,
      async () => {
        const mediaUrl = await evault.resolveMediaUrl(user, streamId);
        return { kind: 'url', url: mediaUrl };
      },
      options,
    );
  }

  private async generate(
    sourceKind: VideoPreviewSourceKind,
    sourceKey: string,
    resolveSource: () => Promise<PreviewFrameSource | undefined>,
    options?: { retryFailed?: boolean },
  ): Promise<VideoPreviewRecord> {
    const existing = await this.store.getBySource(sourceKind, sourceKey);
    if (existing?.status === 'ready' && existing.storageKey) return existing;
    if (
      existing?.status === 'failed' &&
      !shouldRetryFailed(existing, options?.retryFailed === true)
    ) {
      return existing;
    }
    if (existing?.status === 'pending' && !isStale(existing)) {
      return existing;
    }

    const lock = lockKey(sourceKind, sourceKey);
    if (inFlight.has(lock)) {
      return (
        existing ??
        (await this.store.create({
          id: this.createId(),
          sourceKind,
          sourceKey,
          status: 'pending',
        }))
      );
    }

    inFlight.add(lock);
    const record =
      existing ??
      (await this.store.create({
        id: this.createId(),
        sourceKind,
        sourceKey,
        status: 'pending',
      }));
    if (record.status !== 'pending') {
      await this.store.update(record.id, { status: 'pending' });
    }

    try {
      const source = await resolveSource();
      if (!source) {
        const failed = await this.store.update(record.id, { status: 'failed' });
        return failed ?? { ...record, status: 'failed' };
      }
      const extracted = await this.extractor.extractUsefulFrame(source);
      if (!extracted) {
        const failed = await this.store.update(record.id, { status: 'failed' });
        return failed ?? { ...record, status: 'failed' };
      }
      const storageKey = this.storage.createStorageKey();
      await this.storage.write(storageKey, extracted.jpeg);
      const ready = await this.store.update(record.id, {
        status: 'ready',
        storageKey,
        captureSeconds: extracted.captureSeconds,
        byteSize: extracted.jpeg.byteLength,
        contentType: 'image/jpeg',
      });
      return ready ?? { ...record, status: 'ready', storageKey };
    } catch (error) {
      if (isRetryablePreviewSourceError(error)) {
        const pending = await this.store.update(record.id, { status: 'pending' });
        return pending ?? { ...record, status: 'pending' };
      }
      const failed = await this.store.update(record.id, { status: 'failed' });
      return failed ?? { ...record, status: 'failed' };
    } finally {
      inFlight.delete(lock);
    }
  }

  private async sourceFromAsset(storageKey: string): Promise<PreviewFrameSource | undefined> {
    if (this.storage instanceof LocalDiskMediaStorage) {
      return { kind: 'path', path: this.storage.resolveObjectPath(storageKey) };
    }
    const bytes = await this.storage.read(storageKey);
    return { kind: 'bytes', bytes };
  }

  private async openRecord(
    record: VideoPreviewRecord,
  ): Promise<PreviewDownload | { status: 'processing' } | { status: 'unavailable' }> {
    if (record.status === 'ready' && record.storageKey) {
      const body = await this.storage.read(record.storageKey);
      return {
        status: 'ready',
        body,
        contentType: record.contentType || 'image/jpeg',
      };
    }
    if (record.status === 'pending') return { status: 'processing' };
    return { status: 'unavailable' };
  }

  private requireEVaultSource(): AuthorizedEVaultPreviewSource {
    if (this.evault) return this.evault;
    throw new VideoPreviewError('eVault preview access is not configured.', 'internal_error', 503);
  }
}

function isRetryablePreviewSourceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && (status === 429 || status >= 500);
}

function statusToState(status: VideoPreviewStatus | undefined): VideoPreviewState {
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'unavailable';
  return 'processing';
}

function lockKey(sourceKind: VideoPreviewSourceKind, sourceKey: string): string {
  return `${sourceKind}:${sourceKey}`;
}

function isStale(record: VideoPreviewRecord): boolean {
  const updated = Date.parse(record.updatedAt);
  return !Number.isFinite(updated) || Date.now() - updated > stalePendingMs;
}

function isStaleFailed(record: VideoPreviewRecord): boolean {
  const updated = Date.parse(record.updatedAt);
  return Number.isFinite(updated) && Date.now() - updated > staleFailedMs;
}

function shouldRetryFailed(record: VideoPreviewRecord, retryFailed: boolean): boolean {
  return retryFailed || isStaleFailed(record);
}

export function sanitizeOwnedVideoForLibrary(video: Video): Video {
  const thumbnailUrl = normalizePersistedThumbnailUrl(video.thumbnailUrl);
  return {
    ...video,
    thumbnailUrl: thumbnailUrl || ownedVideoPreviewPath(video.id),
  };
}

let sharedService: VideoPreviewService | undefined;

export function createVideoPreviewService(
  evault: AuthorizedEVaultPreviewSource,
): VideoPreviewService {
  const db = getW3dsDatabase();
  return new VideoPreviewService({
    store: new PostgresVideoPreviewStore(db),
    storage: new LocalDiskMediaStorage(resolveLocalMediaStorageRoot()),
    videos: new PostgresCreatorVideoStore(db),
    media: new PostgresMediaAssetStore(db),
    evault,
  });
}

export function getVideoPreviewService(
  evault?: AuthorizedEVaultPreviewSource,
): VideoPreviewService {
  if (!sharedService) {
    if (!evault) {
      throw new VideoPreviewError(
        'eVault preview access is not configured.',
        'internal_error',
        503,
      );
    }
    sharedService = createVideoPreviewService(evault);
  }
  return sharedService;
}

export function resetVideoPreviewServiceForTests(): void {
  sharedService = undefined;
}
