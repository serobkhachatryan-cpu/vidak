import { and, asc, desc, eq, like } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import { type MediaUploadState, mediaAssets, videos } from './db/schema';
import { MediaAssetError } from './media-asset-errors';
import { isThumbnailMediaContentType, isVideoMediaContentType } from './media-limits';
import { assertSafeStorageKey } from './media-storage';

export type { MediaUploadState } from './db/schema';

const uploadStates = [
  'pending',
  'uploading',
  'ready',
  'failed',
] as const satisfies readonly MediaUploadState[];

/**
 * Server-only projection of a durable media asset row.
 * Bytes are addressed by `storageKey` through MediaStorage.
 */
export interface MediaAsset {
  id: string;
  ownerId: string;
  videoId: string;
  storageKey: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  uploadState: MediaUploadState;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMediaAssetRecordInput {
  id: string;
  ownerId: string;
  videoId: string;
  storageKey: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  /** Defaults to `pending` when omitted. */
  uploadState?: MediaUploadState;
}

/**
 * Durable persistence for media asset metadata linked to creator video drafts.
 * Runtime production uses PostgreSQL; in-memory exists only for unit tests.
 */
export interface MediaAssetStore {
  /**
   * Creates a media asset for an owned draft. Rejects when the draft is missing
   * or owned by another user, or when the storage key is unsafe / duplicate.
   */
  createAsset(input: CreateMediaAssetRecordInput): Promise<MediaAsset>;
  /** Returns the asset only when it exists and is owned by `ownerId`. */
  getOwnedAsset(assetId: string, ownerId: string): Promise<MediaAsset | undefined>;
  listOwnedAssetsByVideoId(videoId: string, ownerId: string): Promise<MediaAsset[]>;
  updateUploadState(
    assetId: string,
    ownerId: string,
    uploadState: MediaUploadState,
  ): Promise<MediaAsset | undefined>;
  /**
   * Deletes an owned asset and returns the removed row (for MediaStorage cleanup).
   * Returns undefined when the asset is missing or not owned by `ownerId`.
   */
  deleteOwnedAsset(assetId: string, ownerId: string): Promise<MediaAsset | undefined>;
  /**
   * Returns a ready asset linked to `videoId` without ownership checks.
   * Used by anonymous published-media streaming after the video has already
   * been validated as published + public/unlisted.
   */
  getReadyAssetForVideo(videoId: string, assetId: string): Promise<MediaAsset | undefined>;
  /**
   * Returns the oldest ready *video* asset for `videoId` (stable primary playback source).
   * Image/thumbnail assets are excluded so they cannot become the playback source.
   * Callers must already have validated published public/unlisted visibility.
   */
  getPrimaryReadyAssetForVideo(videoId: string): Promise<MediaAsset | undefined>;
  /**
   * Returns all ready *video* assets for `videoId`, oldest first. Used by public
   * playback metadata after visibility has already been validated.
   */
  listReadyVideoAssetsForVideo(videoId: string): Promise<MediaAsset[]>;
  /**
   * Returns the newest ready thumbnail image asset for `videoId`.
   * Callers must already have validated ownership or published visibility.
   */
  getReadyThumbnailAssetForVideo(videoId: string): Promise<MediaAsset | undefined>;
}

function cloneAsset(asset: MediaAsset): MediaAsset {
  return { ...asset };
}

function toMediaAsset(row: {
  id: string;
  ownerId: string;
  videoId: string;
  storageKey: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  uploadState: MediaUploadState;
  createdAt: Date;
  updatedAt: Date;
}): MediaAsset {
  return {
    id: row.id,
    ownerId: row.ownerId,
    videoId: row.videoId,
    storageKey: row.storageKey,
    originalFilename: row.originalFilename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    uploadState: row.uploadState,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeCreateInput(input: CreateMediaAssetRecordInput): CreateMediaAssetRecordInput {
  if (!input || typeof input !== 'object') {
    throw new MediaAssetError('Media asset input is required.', 'validation_failed', 400);
  }
  if (!input.id?.trim()) {
    throw new MediaAssetError('Media asset id is required.', 'validation_failed', 400);
  }
  if (!input.ownerId?.trim()) {
    throw new MediaAssetError('Owner id is required.', 'validation_failed', 400);
  }
  if (!input.videoId?.trim()) {
    throw new MediaAssetError('Video id is required.', 'validation_failed', 400);
  }
  assertSafeStorageKey(input.storageKey);
  const originalFilename =
    typeof input.originalFilename === 'string' ? input.originalFilename.trim() : '';
  if (!originalFilename) {
    throw new MediaAssetError('Original filename is required.', 'validation_failed', 400);
  }
  if (originalFilename.length > 512) {
    throw new MediaAssetError(
      'Original filename must be 512 characters or fewer.',
      'validation_failed',
      400,
    );
  }
  const contentType = typeof input.contentType === 'string' ? input.contentType.trim() : '';
  if (!contentType) {
    throw new MediaAssetError('Content type is required.', 'validation_failed', 400);
  }
  if (contentType.length > 255) {
    throw new MediaAssetError(
      'Content type must be 255 characters or fewer.',
      'validation_failed',
      400,
    );
  }
  if (
    typeof input.byteSize !== 'number' ||
    !Number.isInteger(input.byteSize) ||
    input.byteSize < 0
  ) {
    throw new MediaAssetError(
      'Byte size must be a non-negative integer.',
      'validation_failed',
      400,
    );
  }
  const uploadState = input.uploadState ?? 'pending';
  if (!(uploadStates as readonly string[]).includes(uploadState)) {
    throw new MediaAssetError('Upload state is invalid.', 'validation_failed', 400);
  }
  return {
    id: input.id.trim(),
    ownerId: input.ownerId.trim(),
    videoId: input.videoId.trim(),
    storageKey: input.storageKey,
    originalFilename,
    contentType,
    byteSize: input.byteSize,
    uploadState,
  };
}

function normalizeUploadState(uploadState: MediaUploadState): MediaUploadState {
  if (!(uploadStates as readonly string[]).includes(uploadState)) {
    throw new MediaAssetError('Upload state is invalid.', 'validation_failed', 400);
  }
  return uploadState;
}

/** In-memory store for unit tests only — never used as a production fallback. */
export class InMemoryMediaAssetStore implements MediaAssetStore {
  private readonly assetsById = new Map<string, MediaAsset>();
  private readonly storageKeys = new Set<string>();
  /** videoId → ownerId for drafts that may receive media assets. */
  private readonly ownedDrafts = new Map<string, string>();

  /** Test helper: registers an owned draft that createAsset may attach media to. */
  registerOwnedDraft(videoId: string, ownerId: string): void {
    this.ownedDrafts.set(videoId, ownerId);
  }

  async createAsset(input: CreateMediaAssetRecordInput): Promise<MediaAsset> {
    const normalized = normalizeCreateInput(input);
    const draftOwnerId = this.ownedDrafts.get(normalized.videoId);
    if (!draftOwnerId || draftOwnerId !== normalized.ownerId) {
      throw new MediaAssetError('Video draft was not found for this owner.', 'not_found', 404);
    }
    if (this.storageKeys.has(normalized.storageKey)) {
      throw new MediaAssetError('Storage key is already in use.', 'conflict', 409);
    }
    if (this.assetsById.has(normalized.id)) {
      throw new MediaAssetError('Media asset id is already in use.', 'conflict', 409);
    }
    const now = new Date().toISOString();
    const asset: MediaAsset = {
      id: normalized.id,
      ownerId: normalized.ownerId,
      videoId: normalized.videoId,
      storageKey: normalized.storageKey,
      originalFilename: normalized.originalFilename,
      contentType: normalized.contentType,
      byteSize: normalized.byteSize,
      uploadState: normalized.uploadState ?? 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.assetsById.set(asset.id, asset);
    this.storageKeys.add(asset.storageKey);
    return cloneAsset(asset);
  }

  async getOwnedAsset(assetId: string, ownerId: string): Promise<MediaAsset | undefined> {
    const asset = this.assetsById.get(assetId);
    if (!asset || asset.ownerId !== ownerId) return undefined;
    return cloneAsset(asset);
  }

  async listOwnedAssetsByVideoId(videoId: string, ownerId: string): Promise<MediaAsset[]> {
    return [...this.assetsById.values()]
      .filter((asset) => asset.videoId === videoId && asset.ownerId === ownerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneAsset);
  }

  async updateUploadState(
    assetId: string,
    ownerId: string,
    uploadState: MediaUploadState,
  ): Promise<MediaAsset | undefined> {
    const nextState = normalizeUploadState(uploadState);
    const existing = this.assetsById.get(assetId);
    if (!existing || existing.ownerId !== ownerId) return undefined;
    const next: MediaAsset = {
      ...existing,
      uploadState: nextState,
      updatedAt: new Date().toISOString(),
    };
    this.assetsById.set(assetId, next);
    return cloneAsset(next);
  }

  async deleteOwnedAsset(assetId: string, ownerId: string): Promise<MediaAsset | undefined> {
    const existing = this.assetsById.get(assetId);
    if (!existing || existing.ownerId !== ownerId) return undefined;
    this.assetsById.delete(assetId);
    this.storageKeys.delete(existing.storageKey);
    return cloneAsset(existing);
  }

  async getReadyAssetForVideo(videoId: string, assetId: string): Promise<MediaAsset | undefined> {
    const asset = this.assetsById.get(assetId);
    if (!asset || asset.videoId !== videoId || asset.uploadState !== 'ready') return undefined;
    return cloneAsset(asset);
  }

  async getPrimaryReadyAssetForVideo(videoId: string): Promise<MediaAsset | undefined> {
    const normalized = videoId.trim();
    if (!normalized) return undefined;
    const ready = await this.listReadyVideoAssetsForVideo(normalized);
    const primary = ready[0];
    return primary;
  }

  async listReadyVideoAssetsForVideo(videoId: string): Promise<MediaAsset[]> {
    const normalized = videoId.trim();
    if (!normalized) return [];
    return [...this.assetsById.values()]
      .filter(
        (asset) =>
          asset.videoId === normalized &&
          asset.uploadState === 'ready' &&
          isVideoMediaContentType(asset.contentType),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(cloneAsset);
  }

  async getReadyThumbnailAssetForVideo(videoId: string): Promise<MediaAsset | undefined> {
    const normalized = videoId.trim();
    if (!normalized) return undefined;
    const ready = [...this.assetsById.values()]
      .filter(
        (asset) =>
          asset.videoId === normalized &&
          asset.uploadState === 'ready' &&
          isThumbnailMediaContentType(asset.contentType),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const thumbnail = ready[0];
    return thumbnail ? cloneAsset(thumbnail) : undefined;
  }
}

/** PostgreSQL-backed store shared across application instances. */
export class PostgresMediaAssetStore implements MediaAssetStore {
  constructor(private readonly db: W3dsDatabase) {}

  async createAsset(input: CreateMediaAssetRecordInput): Promise<MediaAsset> {
    const normalized = normalizeCreateInput(input);
    const [draft] = await this.db
      .select({ id: videos.id, ownerId: videos.ownerId })
      .from(videos)
      .where(
        and(
          eq(videos.id, normalized.videoId),
          eq(videos.ownerId, normalized.ownerId),
          eq(videos.status, 'draft'),
        ),
      )
      .limit(1);
    if (!draft) {
      throw new MediaAssetError('Video draft was not found for this owner.', 'not_found', 404);
    }

    const now = new Date();
    try {
      const [row] = await this.db
        .insert(mediaAssets)
        .values({
          id: normalized.id,
          ownerId: normalized.ownerId,
          videoId: normalized.videoId,
          storageKey: normalized.storageKey,
          originalFilename: normalized.originalFilename,
          contentType: normalized.contentType,
          byteSize: normalized.byteSize,
          uploadState: normalized.uploadState ?? 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) {
        throw new MediaAssetError('Failed to create media asset.', 'internal_error', 500);
      }
      return toMediaAsset(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new MediaAssetError(
          'Media asset id or storage key is already in use.',
          'conflict',
          409,
        );
      }
      throw error;
    }
  }

  async getOwnedAsset(assetId: string, ownerId: string): Promise<MediaAsset | undefined> {
    const [row] = await this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.ownerId, ownerId)))
      .limit(1);
    return row ? toMediaAsset(row) : undefined;
  }

  async listOwnedAssetsByVideoId(videoId: string, ownerId: string): Promise<MediaAsset[]> {
    const rows = await this.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.videoId, videoId), eq(mediaAssets.ownerId, ownerId)));
    return rows
      .map(toMediaAsset)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async updateUploadState(
    assetId: string,
    ownerId: string,
    uploadState: MediaUploadState,
  ): Promise<MediaAsset | undefined> {
    const nextState = normalizeUploadState(uploadState);
    const [row] = await this.db
      .update(mediaAssets)
      .set({ uploadState: nextState, updatedAt: new Date() })
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.ownerId, ownerId)))
      .returning();
    return row ? toMediaAsset(row) : undefined;
  }

  async deleteOwnedAsset(assetId: string, ownerId: string): Promise<MediaAsset | undefined> {
    const [row] = await this.db
      .delete(mediaAssets)
      .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.ownerId, ownerId)))
      .returning();
    return row ? toMediaAsset(row) : undefined;
  }

  async getReadyAssetForVideo(videoId: string, assetId: string): Promise<MediaAsset | undefined> {
    const [row] = await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.id, assetId),
          eq(mediaAssets.videoId, videoId),
          eq(mediaAssets.uploadState, 'ready'),
        ),
      )
      .limit(1);
    return row ? toMediaAsset(row) : undefined;
  }

  async getPrimaryReadyAssetForVideo(videoId: string): Promise<MediaAsset | undefined> {
    const normalized = videoId.trim();
    if (!normalized) return undefined;
    const [asset] = await this.listReadyVideoAssetsForVideo(normalized);
    return asset;
  }

  async listReadyVideoAssetsForVideo(videoId: string): Promise<MediaAsset[]> {
    const normalized = videoId.trim();
    if (!normalized) return [];
    const rows = await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.videoId, normalized),
          eq(mediaAssets.uploadState, 'ready'),
          like(mediaAssets.contentType, 'video/%'),
        ),
      )
      .orderBy(asc(mediaAssets.createdAt));
    return rows.map(toMediaAsset);
  }

  async getReadyThumbnailAssetForVideo(videoId: string): Promise<MediaAsset | undefined> {
    const normalized = videoId.trim();
    if (!normalized) return undefined;
    const [row] = await this.db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.videoId, normalized),
          eq(mediaAssets.uploadState, 'ready'),
          like(mediaAssets.contentType, 'image/%'),
        ),
      )
      .orderBy(desc(mediaAssets.createdAt))
      .limit(1);
    return row && isThumbnailMediaContentType(row.contentType) ? toMediaAsset(row) : undefined;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
