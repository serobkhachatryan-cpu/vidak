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
  MediaStorageError,
  resolveLocalMediaStorageRoot,
} from '../media-storage';
import { isMediaResolutionAbortedError } from '../meshenger-video-library';
import { reportOperationalEvent } from '../ops-observability';
import {
  backgroundWorkDelayMs,
  beginBackgroundWork,
} from '../video-space/background-work-priority';
import { parseW3dsFileUri } from '../w3ds-official-file-client';
import { evaultVideoPreviewPath, ownedVideoPreviewPath } from './capture-time';
import {
  FfmpegVideoFrameExtractor,
  isRetryableVideoFrameExtractorError,
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
  /**
   * Validates that a stream token is bound to the current viewer without
   * reaching the remote source. Cached posters use this short-lived grant so
   * a grid can render without starting a remote source check for every card.
   */
  inspectBoundStream(user: Pick<AuthUser, 'eName'>, streamId: string): { fileUri: string };
  /**
   * Rechecks that this viewer can currently open the stream before returning
   * the internal cache key. This is intentionally asynchronous: shared grants
   * must verify their source access every time a private preview is requested.
   */
  inspectPlayableStream(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
    options?: { priority?: 'preview' | 'background' | 'interactive'; signal?: AbortSignal },
  ): Promise<{ fileUri: string }>;
  resolveMediaUrl(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
    options?: { priority?: 'preview' | 'background' | 'interactive'; signal?: AbortSignal },
  ): Promise<string>;
  /**
   * Reissues a retained, viewer-bound stream just before low-priority durable
   * work starts. The following File resolution still rechecks current access.
   */
  renewPlayableStream?(user: Pick<AuthUser, 'eName'>, streamId: string): Promise<string>;
}

export interface VideoPreviewServiceOptions {
  store: VideoPreviewStore;
  storage: MediaStorage;
  videos: Pick<
    CreatorVideoStore,
    'getOwnedVideo' | 'setOwnedVideoDuration' | 'repairOwnedVideoTitle'
  >;
  media: Pick<MediaAssetStore, 'getReadyThumbnailAssetForVideo' | 'getPrimaryReadyAssetForVideo'>;
  extractor?: VideoFrameExtractor;
  evault?: AuthorizedEVaultPreviewSource;
  createId?: () => string;
  /** Delay before the background queue retries a retryable preview source once. */
  backfillRetryDelayMs?: number;
}

const inFlight = new Set<string>();
const stalePendingMs = 2 * 60 * 1000;
const staleFailedMs = 60 * 60 * 1000;
// Preview extraction can download and decode remote video. One worker keeps
// the service responsive on the production host and leaves headroom for a
// viewer's actual playback request.
const maxConcurrentBackfillPreviews = 1;
const backfillRetryDelayMs = 15_000;
type BackfillTask = {
  key: string;
  run: () => Promise<VideoPreviewRecord>;
  retryPending?: () => Promise<VideoPreviewRecord>;
};
const unavailableEVaultPoster = new TextEncoder().encode(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" role="img" aria-label="Video">
    <rect width="1280" height="720" fill="#202938"/>
    <rect x="64" y="64" width="1152" height="592" rx="32" fill="#2d384b"/>
    <path d="M547 252v216l190-108-190-108Z" fill="#9aa8c0"/>
  </svg>
`);

export class VideoPreviewService {
  private readonly store: VideoPreviewStore;
  private readonly storage: MediaStorage;
  private readonly videos: Pick<
    CreatorVideoStore,
    'getOwnedVideo' | 'setOwnedVideoDuration' | 'repairOwnedVideoTitle'
  >;
  private readonly media: Pick<
    MediaAssetStore,
    'getReadyThumbnailAssetForVideo' | 'getPrimaryReadyAssetForVideo'
  >;
  private readonly extractor: VideoFrameExtractor;
  private readonly evault: AuthorizedEVaultPreviewSource | undefined;
  private readonly createId: () => string;
  private readonly backfillRetryDelayMs: number;
  private readonly queuedBackfillKeys = new Set<string>();
  private readonly backfillQueue: BackfillTask[] = [];
  private readonly pendingBackfillRetries = new Map<string, number>();
  private activeBackfills = 0;
  private delayedBackfillDrain: ReturnType<typeof setTimeout> | undefined;
  // Repairing a historical library can enqueue hundreds of retained grants.
  // Keep operational signals bounded: they identify the failed stage without
  // turning a single bad eVault source into hundreds of log lines.
  private durablePreviewTaskStartReported = false;
  private durablePreviewRenewalFailureReported = false;
  private backfillQueueDeferredReported = false;

  constructor(options: VideoPreviewServiceOptions) {
    this.store = options.store;
    this.storage = options.storage;
    this.videos = options.videos;
    this.media = options.media;
    this.extractor = options.extractor ?? new FfmpegVideoFrameExtractor();
    this.evault = options.evault;
    this.createId = options.createId ?? (() => randomUUID());
    this.backfillRetryDelayMs = options.backfillRetryDelayMs ?? backfillRetryDelayMs;
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
    const { fileUri } = await this.requireEVaultSource().inspectPlayableStream(user, streamId);
    const record = await this.store.getBySource('evault-file', fileUri);
    // A failed record receives a neutral poster. This keeps a valid video card
    // usable even when its source has no decodable frame.
    if (record?.status === 'failed') return 'ready';
    return statusToState(record?.status);
  }

  /**
   * Reads the local poster state after verifying the signed, viewer-bound
   * stream token. This deliberately does not dereference the shared source:
   * status alone contains no media, and openEVaultPreview rechecks live
   * access before returning even an already-cached image.
   */
  async peekCachedLibraryPreview(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
  ): Promise<VideoPreviewState> {
    const { fileUri } = this.requireEVaultSource().inspectBoundStream(user, streamId);
    const record = await this.store.getBySource('evault-file', fileUri);
    if (record?.status === 'failed') return 'ready';
    return statusToState(record?.status);
  }

  async scheduleOwnedBackfill(
    user: Pick<AuthUser, 'id'>,
    videos: ReadonlyArray<Pick<Video, 'id' | 'thumbnailUrl'>>,
  ): Promise<void> {
    for (const video of videos) {
      this.enqueueBackfill({
        key: `owned:${user.id}:${video.id}`,
        run: () => this.ensureOwnedPreview(user, video.id),
      });
    }
  }

  /**
   * Queues title, metadata, and poster repair for already-published videos. This is
   * deliberately server-side: it never gives a public request access to an
   * owner preview or storage key. It lets older catalogue rows self-heal when
   * their public card is requested.
   */
  async schedulePublishedBackfill(
    videos: ReadonlyArray<Pick<Video, 'id' | 'title' | 'createdAt' | 'durationSeconds'>>,
  ): Promise<void> {
    for (const video of videos) {
      const needsTitleRepair = Boolean(repairedTechnicalTitle(video.title, video.createdAt));
      if (video.durationSeconds > 0 && !needsTitleRepair) continue;
      this.enqueueBackfill({
        key: `published:${video.id}`,
        run: () => this.ensurePublishedPreview(video.id),
      });
    }
  }

  async scheduleLibraryBackfill(
    user: Pick<AuthUser, 'eName'>,
    items: ReadonlyArray<{ streamIds?: readonly string[] }>,
  ): Promise<void> {
    for (const item of items) {
      const streamId = item.streamIds?.[0];
      if (!streamId) continue;
      this.enqueueEVaultBackfill(user, streamId);
    }
  }

  /**
   * Queues a retained catalogue card without freezing a short-lived stream
   * token into a potentially long backfill. Each task renews the original
   * signed stream immediately before it performs the live source check.
   */
  async scheduleDurableLibraryBackfill(
    user: Pick<AuthUser, 'eName'>,
    items: ReadonlyArray<{ streamIds?: readonly string[] }>,
    options?: { retryFailed?: boolean },
  ): Promise<void> {
    for (const item of items) {
      const streamId = item.streamIds?.[0];
      if (!streamId) continue;
      this.enqueueDurableEVaultBackfill(user, streamId, options);
    }
  }

  /**
   * Library requests enqueue preview work rather than starting one extractor
   * per card. A small shared worker pool keeps a large private catalogue from
   * saturating ffmpeg, storage, or the authorized eVault media endpoint.
   */
  private enqueueBackfill(task: BackfillTask): void {
    if (this.queuedBackfillKeys.has(task.key)) return;
    this.queuedBackfillKeys.add(task.key);
    this.backfillQueue.push(task);
    this.drainBackfillQueue();
  }

  /**
   * Shared eVault previews are always background work. Keeping this one
   * construction path prevents a card-image request from bypassing the
   * one-at-a-time worker and competing with real video playback.
   */
  private enqueueEVaultBackfill(user: Pick<AuthUser, 'eName'>, streamId: string): void {
    this.enqueueBackfill({
      key: `evault:${user.eName}:${streamId}`,
      run: () => this.ensureEVaultPreview(user, streamId, { retryFailed: true }),
      retryPending: () =>
        this.ensureEVaultPreview(user, streamId, { retryFailed: true, retryPending: true }),
    });
  }

  private enqueueDurableEVaultBackfill(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
    options?: { retryFailed?: boolean },
  ): void {
    this.enqueueBackfill({
      key: `durable-evault:${user.eName}:${streamId}`,
      run: () => this.ensureRenewedEVaultPreview(user, streamId, options),
      retryPending: () =>
        this.ensureRenewedEVaultPreview(user, streamId, {
          retryPending: true,
          ...(options?.retryFailed === true ? { retryFailed: true } : {}),
        }),
    });
  }

  private drainBackfillQueue(): void {
    const delay = backgroundWorkDelayMs();
    if (delay > 0) {
      if (
        !this.backfillQueueDeferredReported &&
        this.backfillQueue.some((task) => task.key.startsWith('durable-evault:'))
      ) {
        this.backfillQueueDeferredReported = true;
        reportOperationalEvent({
          category: 'video_preview',
          code: 'durable_preview_queue_deferred',
        });
      }
      if (!this.delayedBackfillDrain) {
        this.delayedBackfillDrain = setTimeout(() => {
          this.delayedBackfillDrain = undefined;
          this.drainBackfillQueue();
        }, delay);
        this.delayedBackfillDrain.unref?.();
      }
      return;
    }
    while (this.activeBackfills < maxConcurrentBackfillPreviews && this.backfillQueue.length > 0) {
      const next = this.backfillQueue.shift();
      if (!next) return;
      if (next.key.startsWith('durable-evault:') && !this.durablePreviewTaskStartReported) {
        this.durablePreviewTaskStartReported = true;
        reportOperationalEvent({ category: 'video_preview', code: 'durable_preview_task_started' });
      }
      this.activeBackfills += 1;
      void next
        .run()
        .then((record) => {
          if (record.status === 'pending' && next.retryPending) {
            this.schedulePendingBackfillRetry(next);
          } else {
            this.pendingBackfillRetries.delete(next.key);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.activeBackfills -= 1;
          this.queuedBackfillKeys.delete(next.key);
          this.drainBackfillQueue();
        });
    }
  }

  /** Retry a pending retryable source once without making the catalogue request wait. */
  private schedulePendingBackfillRetry(task: BackfillTask): void {
    const attempts = this.pendingBackfillRetries.get(task.key) ?? 0;
    const retryPending = task.retryPending;
    if (!retryPending) return;
    if (attempts >= 1) {
      this.pendingBackfillRetries.delete(task.key);
      return;
    }
    this.pendingBackfillRetries.set(task.key, attempts + 1);
    const timer = setTimeout(() => {
      this.enqueueBackfill({ ...task, run: retryPending });
    }, this.backfillRetryDelayMs);
    timer.unref?.();
  }

  async openOwnedPreview(
    user: Pick<AuthUser, 'id'>,
    videoId: string,
  ): Promise<PreviewDownload | { status: 'processing' } | { status: 'unavailable' }> {
    const record = await this.ensureOwnedPreview(user, videoId.trim());
    return this.openRecord(record);
  }

  /**
   * Opens a generated preview for a video whose public/unlisted visibility has
   * already been checked by the caller. Unlike openOwnedPreview this method
   * never performs ownership authorization; therefore it must only be used
   * behind the public video lookup route.
   */
  async openPublishedPreview(
    videoId: string,
  ): Promise<PreviewDownload | { status: 'processing' } | { status: 'unavailable' }> {
    const record = await this.ensurePublishedPreview(videoId);
    return this.openRecord(record);
  }

  async openEVaultPreview(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
    options?: { signal?: AbortSignal },
  ): Promise<PreviewDownload | { status: 'processing' } | { status: 'unavailable' }> {
    const evault = this.requireEVaultSource();
    // Reading the sealed viewer-bound grant is local. It lets this ordinary
    // image request join the same preemptible background lane as frame
    // extraction before it starts a remote shared-source authorization.
    const bound = evault.inspectBoundStream(user, streamId);
    const backgroundLease = beginBackgroundWork(parseW3dsFileUri(bound.fileUri)?.ownerEName);
    const signal = options?.signal
      ? AbortSignal.any([options.signal, backgroundLease.signal])
      : backgroundLease.signal;
    // A poster is a cached derivative, not a media redirect. Its viewer-bound
    // grant alone is not enough to serve it after a user has been removed
    // from a shared source. Recheck current access before returning cached
    // private image bytes; the library coalesces and briefly caches positive
    // source proofs so a card grid does not create duplicate probes.
    try {
      // A Watch request may have reserved playback before this card route
      // reaches its first remote read. Do not make that request wait for an
      // unnecessary poster authorization; the client retries this 202 later.
      if (backgroundLease.signal.aborted) return { status: 'processing' };
      const { fileUri } = await evault.inspectPlayableStream(user, streamId, {
        priority: 'preview',
        signal,
      });
      if (backgroundLease.signal.aborted) return { status: 'processing' };
      const existing = await this.store.getBySource('evault-file', fileUri);
      if (existing?.status === 'ready' && existing.storageKey) {
        try {
          return await this.openRecord(existing);
        } catch (error) {
          // The preview row can outlive the storage object when a deployment
          // replaces an ephemeral media volume. Treat that exact condition as
          // a cache miss: retain the live access check above, mark the stale
          // row retryable, and rebuild through the bounded background queue.
          if (!(error instanceof MediaStorageError && error.code === 'not_found')) {
            throw error;
          }
          reportOperationalEvent({
            category: 'video_preview',
            code: 'preview_cached_blob_missing',
          });
          await this.store.update(existing.id, { status: 'failed' });
        }
      }
      if (existing?.status === 'failed' && !isStaleFailed(existing)) {
        return unavailableEVaultPosterDownload();
      }
      if (existing?.status === 'pending' && !isStale(existing)) {
        return { status: 'processing' };
      }
      // A preview route serves an image request, not a user-selected playback
      // action. Never keep it open while it resolves a private source or runs
      // ffmpeg; enqueue one resumable job and let the card poll the local state.
      this.enqueueEVaultBackfill(user, streamId);
      return { status: 'processing' };
    } catch (error) {
      // Preemption is not a source failure. Keep the card's state retryable;
      // this preserves both its preview and the authoritative access check
      // once the foreground playback reservation has ended.
      if (backgroundLease.signal.aborted) return { status: 'processing' };
      throw error;
    } finally {
      backgroundLease.release();
    }
  }

  private async ensureOwnedPreview(
    user: Pick<AuthUser, 'id'>,
    videoId: string,
  ): Promise<VideoPreviewRecord> {
    const owned = await this.videos.getOwnedVideo(videoId, user.id);
    if (!owned) {
      throw new VideoPreviewError('Video was not found.', 'not_found', 404);
    }

    const primary = await this.media.getPrimaryReadyAssetForVideo(owned.id);
    if (primary?.ownerId === user.id) {
      await this.repairOwnedTitle(owned, primary.ownerId);
      await this.recordOwnedDuration(owned, primary);
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

    return this.generate('owned-video', owned.id, async () =>
      primary?.ownerId === user.id ? this.sourceFromAsset(primary.storageKey) : undefined,
    );
  }

  private async ensurePublishedPreview(videoId: string): Promise<VideoPreviewRecord> {
    const normalizedId = videoId.trim();
    if (!normalizedId) {
      throw new VideoPreviewError('Video was not found.', 'not_found', 404);
    }
    const primary = await this.media.getPrimaryReadyAssetForVideo(normalizedId);
    if (!primary) {
      throw new VideoPreviewError('Video preview is unavailable.', 'unavailable', 422);
    }
    // The asset is linked to the video, so its owner is the only principal
    // permitted to receive the internal duration metadata write.
    const owned = await this.videos.getOwnedVideo(normalizedId, primary.ownerId);
    if (owned) {
      await this.repairOwnedTitle(owned, primary.ownerId);
      await this.recordOwnedDuration(owned, primary);
    }
    return this.generate('owned-video', normalizedId, async () =>
      this.sourceFromAsset(primary.storageKey),
    );
  }

  private async recordOwnedDuration(
    video: Pick<Video, 'id' | 'durationSeconds'>,
    asset: { ownerId: string; storageKey: string },
  ): Promise<void> {
    if (video.durationSeconds > 0 || !this.extractor.probeDuration) return;
    try {
      const source = await this.sourceFromAsset(asset.storageKey);
      if (!source) return;
      const duration = await this.extractor.probeDuration(source);
      if (!Number.isFinite(duration) || !duration || duration <= 0) return;
      await this.videos.setOwnedVideoDuration(video.id, asset.ownerId, duration);
    } catch {
      // Duration repair is best-effort. A valid upload must remain usable when
      // a particular media container cannot be probed.
    }
  }

  private async repairOwnedTitle(video: Video, ownerId: string): Promise<void> {
    const repaired = repairedTechnicalTitle(video.title, video.createdAt);
    if (!repaired) return;
    try {
      await this.videos.repairOwnedVideoTitle(video.id, ownerId, video.title, repaired);
    } catch {
      // Naming repair must never make a valid video or preview unavailable.
    }
  }

  private async ensureEVaultPreview(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
    options?: { retryFailed?: boolean; retryPending?: boolean },
  ): Promise<VideoPreviewRecord> {
    const evault = this.requireEVaultSource();
    // Reading the bound grant is local and gives us a stable cache key. Do it
    // before generating any remote eVault work so the dozens of already-ready
    // cards in a shared catalogue never contend with the video a viewer chose
    // to play.
    const { fileUri } = evault.inspectBoundStream(user, streamId);
    return this.generate(
      'evault-file',
      fileUri,
      async (signal) => {
        // `generate` has registered the background lease before it invokes
        // this resolver. A foreground playback reservation can therefore stop
        // a queued preview before it starts a remote authorization request.
        if (signal?.aborted) return undefined;
        // `resolveMediaUrl` is the authoritative File access check already.
        // Do not issue a second remote shared-source authorization here: that
        // redundant read competes with a viewer opening the same eVault.
        const mediaUrl = await evault.resolveMediaUrl(user, streamId, {
          priority: 'preview',
          ...(signal ? { signal } : {}),
        });
        return { kind: 'url', url: mediaUrl };
      },
      options,
    );
  }

  private async ensureRenewedEVaultPreview(
    user: Pick<AuthUser, 'eName'>,
    retainedStreamId: string,
    options?: { retryFailed?: boolean; retryPending?: boolean },
  ): Promise<VideoPreviewRecord> {
    const evault = this.requireEVaultSource();
    const renew = evault.renewPlayableStream;
    if (!renew) {
      throw new VideoPreviewError(
        'Durable eVault preview repair is not configured.',
        'internal_error',
        503,
      );
    }
    // This executes inside the one-at-a-time background queue. A retained
    // grant can be expired; renewal validates its signature and viewer before
    // creating a fresh short-lived stream for the immediately following live
    // eVault/File access check.
    let freshStreamId: string;
    try {
      freshStreamId = await renew(user, retainedStreamId);
    } catch (error) {
      if (!this.durablePreviewRenewalFailureReported) {
        this.durablePreviewRenewalFailureReported = true;
        reportOperationalEvent({
          category: 'video_preview',
          code: 'durable_preview_stream_renewal_failed',
        });
      }
      throw error;
    }
    return this.ensureEVaultPreview(user, freshStreamId, options);
  }

  private async generate(
    sourceKind: VideoPreviewSourceKind,
    sourceKey: string,
    resolveSource: (signal?: AbortSignal) => Promise<PreviewFrameSource | undefined>,
    options?: { retryFailed?: boolean; retryPending?: boolean },
  ): Promise<VideoPreviewRecord> {
    const existing = await this.store.getBySource(sourceKind, sourceKey);
    if (existing?.status === 'ready' && existing.storageKey) return existing;
    if (
      existing?.status === 'failed' &&
      !shouldRetryFailed(existing, options?.retryFailed === true)
    ) {
      return existing;
    }
    if (existing?.status === 'pending' && !isStale(existing) && !options?.retryPending) {
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

    // Scope the lease to the source eVault. A Watch action for one shared
    // video can stop its competing preview extraction without postponing
    // previews for every other shared source.
    const backgroundLease =
      sourceKind === 'evault-file'
        ? beginBackgroundWork(parseW3dsFileUri(sourceKey)?.ownerEName)
        : undefined;
    try {
      const source = await resolveSource(backgroundLease?.signal);
      if (backgroundLease?.signal.aborted) return this.leavePending(record);
      if (!source) {
        reportOperationalEvent({ category: 'video_preview', code: 'preview_source_unavailable' });
        const failed = await this.store.update(record.id, { status: 'failed' });
        return failed ?? { ...record, status: 'failed' };
      }
      const extracted = await this.extractor.extractUsefulFrame(
        source,
        backgroundLease ? { signal: backgroundLease.signal } : undefined,
      );
      if (backgroundLease?.signal.aborted) return this.leavePending(record);
      if (!extracted) {
        reportOperationalEvent({ category: 'video_preview', code: 'preview_frame_unavailable' });
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
      if (backgroundLease?.signal.aborted) return this.leavePending(record);
      if (isRetryablePreviewSourceError(error)) {
        reportOperationalEvent({ category: 'video_preview', code: 'preview_source_retryable' });
        const pending = await this.store.update(record.id, { status: 'pending' });
        return pending ?? { ...record, status: 'pending' };
      }
      reportOperationalEvent({ category: 'video_preview', code: 'preview_generation_failed' });
      const failed = await this.store.update(record.id, { status: 'failed' });
      return failed ?? { ...record, status: 'failed' };
    } finally {
      backgroundLease?.release();
      inFlight.delete(lock);
    }
  }

  private async leavePending(record: VideoPreviewRecord): Promise<VideoPreviewRecord> {
    const pending = await this.store.update(record.id, { status: 'pending' });
    return pending ?? { ...record, status: 'pending' };
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
  if (isRetryableVideoFrameExtractorError(error)) return true;
  if (isMediaResolutionAbortedError(error)) return true;
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

/**
 * Camera/recorder defaults have no useful meaning as a public title. Keep the
 * rule deliberately narrow so a creator's descriptive filename remains their
 * title; a concurrent manual edit is protected by the store compare-and-set.
 */
function repairedTechnicalTitle(title: string, createdAt: string): string | undefined {
  const normalized = title.trim().replace(/[_-]+/g, ' ');
  if (!/^(?:img|dsc|mov|video|clip|recording)\s*\d{2,}(?:\s*\(\d+\))?$/i.test(normalized)) {
    return undefined;
  }
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return 'Video upload';
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(created);
  return `Video from ${date}`;
}

function unavailableEVaultPosterDownload(): PreviewDownload {
  return {
    status: 'ready',
    body: unavailableEVaultPoster,
    contentType: 'image/svg+xml',
  };
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
