import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { InMemoryCreatorVideoStore } from '../creator-video-store';
import { InMemoryMediaAssetStore } from '../media-asset-store';
import {
  LocalDiskMediaStorage,
  type MediaStorage,
  MediaStorageError,
  type MediaUploadSession,
} from '../media-storage';
import { setOperationalLogSinkForTests } from '../ops-observability';
import {
  reserveInteractivePlayback,
  resetBackgroundWorkPriorityForTests,
} from '../video-space/background-work-priority';
import { type PreviewFrameSource, VideoFrameExtractorError } from './frame-extractor';
import { sanitizeOwnedVideoForLibrary, VideoPreviewService } from './preview-service';
import { InMemoryVideoPreviewStore } from './preview-store';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);

class MemoryMediaStorage implements MediaStorage {
  readonly objects = new Map<string, Uint8Array>();

  createStorageKey(): string {
    return `media_${randomUUID()}`;
  }

  async write(storageKey: string, data: Uint8Array): Promise<void> {
    this.objects.set(storageKey, data);
  }

  async read(storageKey: string): Promise<Uint8Array> {
    const data = this.objects.get(storageKey);
    if (!data) throw new MediaStorageError('Media object was not found.', 'not_found');
    return data;
  }

  async openUpload(): Promise<MediaUploadSession> {
    throw new Error('not used');
  }

  async openReadStream(): Promise<ReadableStream<Uint8Array>> {
    throw new Error('not used');
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey);
  }

  async exists(storageKey: string): Promise<boolean> {
    return this.objects.has(storageKey);
  }
}

async function seedOwnedDraft(
  videos: InMemoryCreatorVideoStore,
  input: {
    id: string;
    ownerId: string;
    title: string;
    thumbnailUrl?: string;
  },
) {
  await videos.findOrCreateChannel({
    id: `channel-${input.ownerId}`,
    ownerId: input.ownerId,
    handle: `handle-${input.ownerId}`,
    name: 'Owner',
  });
  return videos.createDraft({
    id: input.id,
    channelId: `channel-${input.ownerId}`,
    ownerId: input.ownerId,
    title: input.title,
    description: '',
    tags: [],
    visibility: 'private',
    thumbnailUrl: input.thumbnailUrl ?? '',
  });
}

function createService(options?: {
  captureSeconds?: number;
  extract?: (
    source: PreviewFrameSource,
    options?: { signal?: AbortSignal },
  ) => Promise<{ jpeg: Uint8Array; captureSeconds: number } | undefined>;
  evaultUrl?: string;
}) {
  const videos = new InMemoryCreatorVideoStore();
  const media = new InMemoryMediaAssetStore();
  const storage = new MemoryMediaStorage();
  const store = new InMemoryVideoPreviewStore();
  const service = new VideoPreviewService({
    store,
    storage,
    videos,
    media,
    extractor: {
      extractUsefulFrame: options?.extract
        ? options.extract
        : async () => ({
            jpeg,
            captureSeconds: options?.captureSeconds ?? 3,
          }),
    },
    evault: {
      inspectBoundStream: (_user, streamId) => {
        if (streamId === 'other-stream') {
          const error = new Error('This video is not available to this account.') as Error & {
            status: number;
          };
          error.status = 403;
          throw error;
        }
        return { fileUri: `w3ds://file?id=@owner.w3id/${streamId}` };
      },
      inspectPlayableStream: async (_user, streamId) => {
        if (streamId === 'other-stream') {
          const error = new Error('This video is not available to this account.') as Error & {
            status: number;
          };
          error.status = 403;
          throw error;
        }
        return { fileUri: `w3ds://file?id=@owner.w3id/${streamId}` };
      },
      resolveMediaUrl: async () => options?.evaultUrl ?? 'https://media.example/private.mp4',
    },
  });
  return { service, videos, media, storage, store };
}

describe('VideoPreviewService', () => {
  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
    resetBackgroundWorkPriorityForTests();
  });

  it('preempts an active shared preview when playback begins', async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { service, store } = createService({
      extract: async (_source, options) => {
        markStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return undefined;
      },
    });

    await service.scheduleLibraryBackfill({ eName: '@viewer.w3id' }, [
      { streamIds: ['shared-stream'] },
    ]);
    await started;
    reserveInteractivePlayback(30_000);

    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/shared-stream'),
      ).resolves.toMatchObject({ status: 'pending' });
    });
    await expect(
      service.openEVaultPreview({ eName: '@viewer.w3id' }, 'shared-stream'),
    ).resolves.toEqual({ status: 'processing' });
  });

  it('cancels an in-flight preview source resolution when playback takes priority', async () => {
    let markResolutionStarted: () => void = () => undefined;
    const resolutionStarted = new Promise<void>((resolve) => {
      markResolutionStarted = resolve;
    });
    let resolutionSignal: AbortSignal | undefined;
    const inspectPlayableStream = vi.fn();
    const resolveMediaUrl = vi.fn(
      async (
        _user,
        _streamId,
        options?: { priority?: 'preview' | 'background'; signal?: AbortSignal },
      ) => {
        resolutionSignal = options?.signal;
        markResolutionStarted();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        });
        return 'https://media.example/private.mp4';
      },
    );
    const store = new InMemoryVideoPreviewStore();
    const service = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      extractor: { extractUsefulFrame: async () => ({ jpeg, captureSeconds: 3 }) },
      evault: {
        inspectBoundStream: () => ({ fileUri: 'w3ds://file?id=@owner.w3id/shared-stream' }),
        inspectPlayableStream,
        resolveMediaUrl,
      },
    });

    await service.scheduleLibraryBackfill({ eName: '@viewer.w3id' }, [
      { streamIds: ['shared-stream'] },
    ]);
    await resolutionStarted;
    reserveInteractivePlayback(30_000);

    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/shared-stream'),
      ).resolves.toMatchObject({ status: 'pending' });
    });
    expect(inspectPlayableStream).not.toHaveBeenCalled();
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      { eName: '@viewer.w3id' },
      'shared-stream',
      expect.objectContaining({ priority: 'preview' }),
    );
    expect(resolutionSignal?.aborted).toBe(true);
  });

  it('preempts an in-flight live poster authorization for interactive playback', async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let authorizationSignal: AbortSignal | undefined;
    const inspectPlayableStream = vi.fn(
      async (
        _user,
        _streamId,
        options?: { priority?: 'preview' | 'background'; signal?: AbortSignal },
      ) => {
        authorizationSignal = options?.signal;
        markStarted();
        return new Promise<{ fileUri: string }>((_resolve, reject) => {
          if (options?.signal?.aborted) {
            reject(new Error('cancelled'));
            return;
          }
          options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true,
          });
        });
      },
    );
    const service = new VideoPreviewService({
      store: new InMemoryVideoPreviewStore(),
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      evault: {
        inspectBoundStream: () => ({ fileUri: 'w3ds://file?id=@owner.w3id/shared-stream' }),
        inspectPlayableStream,
        resolveMediaUrl: async () => 'https://media.example/private.mp4',
      },
    });

    const preview = service.openEVaultPreview({ eName: '@viewer.w3id' }, 'shared-stream');
    await started;
    reserveInteractivePlayback(30_000);

    await expect(preview).resolves.toEqual({ status: 'processing' });
    expect(authorizationSignal?.aborted).toBe(true);
    expect(inspectPlayableStream).toHaveBeenCalledWith(
      { eName: '@viewer.w3id' },
      'shared-stream',
      expect.objectContaining({ priority: 'preview' }),
    );
  });

  it('does not remotely authorize a cached eVault preview during catalogue backfill', async () => {
    const store = new InMemoryVideoPreviewStore();
    const storage = new MemoryMediaStorage();
    const storageKey = storage.createStorageKey();
    await storage.write(storageKey, jpeg);
    await store.create({
      id: 'cached-preview-backfill',
      sourceKind: 'evault-file',
      sourceKey: 'w3ds://file?id=@owner.w3id/cached-stream',
      storageKey,
      status: 'ready',
      contentType: 'image/jpeg',
      byteSize: jpeg.byteLength,
    });
    const inspectBoundStream = vi.fn().mockReturnValue({
      fileUri: 'w3ds://file?id=@owner.w3id/cached-stream',
    });
    const inspectPlayableStream = vi.fn();
    const resolveMediaUrl = vi.fn();
    const service = new VideoPreviewService({
      store,
      storage,
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      evault: { inspectBoundStream, inspectPlayableStream, resolveMediaUrl },
    });

    await service.scheduleLibraryBackfill({ eName: '@viewer.w3id' }, [
      { streamIds: ['cached-stream'] },
    ]);
    await vi.waitFor(() => expect(inspectBoundStream).toHaveBeenCalledTimes(1));
    expect(inspectPlayableStream).not.toHaveBeenCalled();
    expect(resolveMediaUrl).not.toHaveBeenCalled();
  });

  it('queues uncached shared poster requests behind one background worker', async () => {
    let active = 0;
    let highestActive = 0;
    let release: (() => void) | undefined;
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, store } = createService({
      extract: async () => {
        active += 1;
        highestActive = Math.max(highestActive, active);
        await unblock;
        active -= 1;
        return { jpeg, captureSeconds: 3 };
      },
    });

    await expect(
      Promise.all(
        ['one', 'two', 'three'].map((streamId) =>
          service.openEVaultPreview({ eName: '@viewer.w3id' }, streamId),
        ),
      ),
    ).resolves.toEqual([
      { status: 'processing' },
      { status: 'processing' },
      { status: 'processing' },
    ]);
    await vi.waitFor(() => expect(active).toBe(1));
    expect(highestActive).toBe(1);

    release?.();
    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/three'),
      ).resolves.toMatchObject({ status: 'ready' });
    });
    expect(highestActive).toBe(1);
  });

  it('uses an existing valid poster when a ready thumbnail asset is present', async () => {
    const { videos, media, storage } = createService();
    const video = await seedOwnedDraft(videos, {
      id: 'video-owned',
      ownerId: 'user-1',
      title: 'friends with hats',
      thumbnailUrl: '/api/videos/drafts/video-owned/thumbnail',
    });
    media.registerOwnedDraft(video.id, 'user-1');
    const storageKey = storage.createStorageKey();
    await storage.write(storageKey, jpeg);
    await media.createAsset({
      id: 'thumb-1',
      ownerId: 'user-1',
      videoId: video.id,
      storageKey,
      originalFilename: 'poster.jpg',
      contentType: 'image/jpeg',
      byteSize: jpeg.byteLength,
      uploadState: 'ready',
    });

    const captured: number[] = [];
    const extracting = new VideoPreviewService({
      store: new InMemoryVideoPreviewStore(),
      storage,
      videos,
      media,
      extractor: {
        extractUsefulFrame: async () => {
          captured.push(1);
          return { jpeg, captureSeconds: 3 };
        },
      },
    });

    const download = await extracting.openOwnedPreview({ id: 'user-1' }, video.id);
    expect(download.status).toBe('ready');
    if (download.status === 'ready') expect(download.body).toEqual(jpeg);
    expect(captured).toEqual([]);
    expect(extracting.describeOwnedPoster(video).posterUrl).toBe(
      '/api/videos/drafts/video-owned/thumbnail',
    );
  });

  it('persists probed duration even when the creator uploaded a poster', async () => {
    const { videos, media, storage } = createService();
    const video = await seedOwnedDraft(videos, {
      id: 'video-duration',
      ownerId: 'user-1',
      title: 'A real clip',
      thumbnailUrl: '/api/videos/drafts/video-duration/thumbnail',
    });
    media.registerOwnedDraft(video.id, 'user-1');
    const mediaStorageKey = storage.createStorageKey();
    const thumbnailStorageKey = storage.createStorageKey();
    await storage.write(mediaStorageKey, new Uint8Array([1, 2, 3]));
    await storage.write(thumbnailStorageKey, jpeg);
    await media.createAsset({
      id: 'media-duration',
      ownerId: 'user-1',
      videoId: video.id,
      storageKey: mediaStorageKey,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      byteSize: 3,
      uploadState: 'ready',
    });
    await media.createAsset({
      id: 'poster-duration',
      ownerId: 'user-1',
      videoId: video.id,
      storageKey: thumbnailStorageKey,
      originalFilename: 'poster.jpg',
      contentType: 'image/jpeg',
      byteSize: jpeg.byteLength,
      uploadState: 'ready',
    });

    const service = new VideoPreviewService({
      store: new InMemoryVideoPreviewStore(),
      storage,
      videos,
      media,
      extractor: {
        extractUsefulFrame: async () => ({ jpeg, captureSeconds: 3 }),
        probeDuration: async () => 31.6,
      },
    });

    await expect(service.openOwnedPreview({ id: 'user-1' }, video.id)).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(videos.getOwnedVideo(video.id, 'user-1')).resolves.toMatchObject({
      durationSeconds: 32,
    });
  });

  it('derives a still at a useful non-black timestamp when no poster exists', async () => {
    const { service, videos, media, storage } = createService({ captureSeconds: 3 });
    const video = await seedOwnedDraft(videos, {
      id: 'video-owned',
      ownerId: 'user-1',
      title: 'IMG 1589',
    });
    media.registerOwnedDraft(video.id, 'user-1');
    const storageKey = storage.createStorageKey();
    await storage.write(storageKey, new Uint8Array([1, 2, 3]));
    await media.createAsset({
      id: 'media-1',
      ownerId: 'user-1',
      videoId: video.id,
      storageKey,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      byteSize: 3,
      uploadState: 'ready',
    });

    const download = await service.openOwnedPreview({ id: 'user-1' }, video.id);
    expect(download.status).toBe('ready');
    if (download.status === 'ready') {
      expect(download.contentType).toBe('image/jpeg');
      expect(download.body).toEqual(jpeg);
    }
    const record = await service
      .openOwnedPreview({ id: 'user-1' }, video.id)
      .then((result) => result);
    expect(record.status).toBe('ready');
    await expect(videos.getOwnedVideo(video.id, 'user-1')).resolves.toMatchObject({
      title: expect.stringMatching(/^Video from /),
    });
  });

  it('repairs a technical published title even after its duration has been backfilled', async () => {
    const { service, videos, media, storage } = createService();
    const video = await seedOwnedDraft(videos, {
      id: 'video-published-title',
      ownerId: 'user-1',
      title: 'IMG_1589',
    });
    media.registerOwnedDraft(video.id, 'user-1');
    const storageKey = storage.createStorageKey();
    await storage.write(storageKey, new Uint8Array([1, 2, 3]));
    await media.createAsset({
      id: 'media-published-title',
      ownerId: 'user-1',
      videoId: video.id,
      storageKey,
      originalFilename: 'IMG_1589.mp4',
      contentType: 'video/mp4',
      byteSize: 3,
      uploadState: 'ready',
    });
    const backfilled = await videos.setOwnedVideoDuration(video.id, 'user-1', 42);
    if (!backfilled) throw new Error('Expected seeded video duration to persist.');

    await service.schedulePublishedBackfill([backfilled]);

    await vi.waitFor(async () => {
      await expect(videos.getOwnedVideo(video.id, 'user-1')).resolves.toMatchObject({
        title: expect.stringMatching(/^Video from /),
        durationSeconds: 42,
      });
    });
  });

  it('does not publish when a private preview is generated', async () => {
    const { service, videos, media, storage } = createService();
    const video = await seedOwnedDraft(videos, {
      id: 'video-owned',
      ownerId: 'user-1',
      title: 'friends with hats',
    });
    media.registerOwnedDraft(video.id, 'user-1');
    const storageKey = storage.createStorageKey();
    await storage.write(storageKey, new Uint8Array([9]));
    await media.createAsset({
      id: 'media-1',
      ownerId: 'user-1',
      videoId: video.id,
      storageKey,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      byteSize: 1,
      uploadState: 'ready',
    });

    await service.openOwnedPreview({ id: 'user-1' }, video.id);
    const stored = await videos.getOwnedVideo(video.id, 'user-1');
    expect(stored?.visibility).toBe('private');
    expect(stored?.status).toBe('draft');
    expect(stored?.thumbnailUrl).toBe('');
  });

  it('rejects another account fetching an owned derived preview', async () => {
    const { service, videos, media, storage } = createService();
    const video = await seedOwnedDraft(videos, {
      id: 'video-owned',
      ownerId: 'user-1',
      title: 'IMG 1589',
    });
    media.registerOwnedDraft(video.id, 'user-1');
    const storageKey = storage.createStorageKey();
    await storage.write(storageKey, new Uint8Array([9]));
    await media.createAsset({
      id: 'media-1',
      ownerId: 'user-1',
      videoId: video.id,
      storageKey,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      byteSize: 1,
      uploadState: 'ready',
    });
    await service.openOwnedPreview({ id: 'user-1' }, video.id);

    await expect(service.openOwnedPreview({ id: 'user-2' }, video.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects an unauthorized eVault preview grant', async () => {
    const { service } = createService();
    await expect(
      service.openEVaultPreview({ eName: '@viewer.w3id' }, 'other-stream'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('renews an expired retained grant before serving its ready eVault poster', async () => {
    const store = new InMemoryVideoPreviewStore();
    const storage = new MemoryMediaStorage();
    const storageKey = storage.createStorageKey();
    const fileUri = 'w3ds://file?id=@owner.w3id/retained-file';
    await storage.write(storageKey, jpeg);
    await store.create({
      id: 'renewed-cached-preview',
      sourceKind: 'evault-file',
      sourceKey: fileUri,
      storageKey,
      status: 'ready',
      contentType: 'image/jpeg',
      byteSize: jpeg.byteLength,
    });
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri });
    const evault = {
      renewCalls: 0,
      inspectBoundStream: (_user: { eName: string }, streamId: string) => {
        if (streamId === 'expired-stream') {
          throw Object.assign(new Error('expired'), { code: 'stream_expired', status: 401 });
        }
        return { fileUri };
      },
      inspectPlayableStream,
      resolveMediaUrl: async () => 'https://media.example/private.mp4',
      // Keep the mock receiver-dependent: production renewal is an instance
      // method and a detached call would silently reintroduce the same bug.
      renewPlayableStream(_user: { eName: string }, streamId: string): Promise<string> {
        this.renewCalls += 1;
        expect(streamId).toBe('expired-stream');
        return Promise.resolve('renewed-stream');
      },
    };
    const service = new VideoPreviewService({
      store,
      storage,
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      evault,
    });

    await expect(
      service.openEVaultPreview({ eName: '@viewer.w3id' }, 'expired-stream'),
    ).resolves.toMatchObject({ status: 'ready', contentType: 'image/jpeg', body: jpeg });
    expect(evault.renewCalls).toBe(1);
    expect(inspectPlayableStream).toHaveBeenCalledWith(
      { eName: '@viewer.w3id' },
      'renewed-stream',
      expect.objectContaining({ priority: 'preview', signal: expect.anything() }),
    );
  });

  it('renews an expired retained grant before reporting its cached preview state', async () => {
    const store = new InMemoryVideoPreviewStore();
    const fileUri = 'w3ds://file?id=@owner.w3id/retained-file';
    await store.create({
      id: 'renewed-cached-preview-state',
      sourceKind: 'evault-file',
      sourceKey: fileUri,
      storageKey: 'cached-poster',
      status: 'ready',
      contentType: 'image/jpeg',
      byteSize: jpeg.byteLength,
    });
    const evault = {
      renewCalls: 0,
      inspectBoundStream: (_user: { eName: string }, streamId: string) => {
        if (streamId === 'expired-stream') {
          throw Object.assign(new Error('expired'), { code: 'stream_expired', status: 401 });
        }
        return { fileUri };
      },
      inspectPlayableStream: vi.fn(),
      resolveMediaUrl: async () => 'https://media.example/private.mp4',
      renewPlayableStream(_user: { eName: string }, streamId: string): Promise<string> {
        this.renewCalls += 1;
        expect(streamId).toBe('expired-stream');
        return Promise.resolve('renewed-stream');
      },
    };
    const service = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      evault,
    });

    await expect(
      service.peekCachedLibraryPreview({ eName: '@viewer.w3id' }, 'expired-stream'),
    ).resolves.toBe('ready');
    expect(evault.renewCalls).toBe(1);
    expect(evault.inspectPlayableStream).not.toHaveBeenCalled();
  });

  it('never renews an invalid or foreign eVault grant', async () => {
    const renewPlayableStream = vi.fn();
    const service = new VideoPreviewService({
      store: new InMemoryVideoPreviewStore(),
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      evault: {
        inspectBoundStream: () => {
          throw Object.assign(new Error('invalid'), { code: 'invalid_stream', status: 401 });
        },
        inspectPlayableStream: async () => ({
          fileUri: 'w3ds://file?id=@owner.w3id/never-reached',
        }),
        resolveMediaUrl: async () => 'https://media.example/private.mp4',
        renewPlayableStream,
      },
    });

    await expect(
      service.openEVaultPreview({ eName: '@viewer.w3id' }, 'invalid-stream'),
    ).rejects.toMatchObject({ code: 'invalid_stream', status: 401 });
    expect(renewPlayableStream).not.toHaveBeenCalled();
  });

  it('does not serve a cached eVault poster after its live source access is revoked', async () => {
    const store = new InMemoryVideoPreviewStore();
    const storage = new MemoryMediaStorage();
    const storageKey = storage.createStorageKey();
    await storage.write(storageKey, jpeg);
    await store.create({
      id: 'cached-preview',
      sourceKind: 'evault-file',
      sourceKey: 'w3ds://file?id=@owner.w3id/cached-stream',
      storageKey,
      status: 'ready',
      contentType: 'image/jpeg',
      byteSize: jpeg.byteLength,
    });
    const accessRevoked = Object.assign(new Error('source access is revoked'), { status: 403 });
    const inspectPlayableStream = vi.fn().mockRejectedValue(accessRevoked);
    const service = new VideoPreviewService({
      store,
      storage,
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      evault: {
        inspectBoundStream: () => ({
          fileUri: 'w3ds://file?id=@owner.w3id/cached-stream',
        }),
        inspectPlayableStream,
        resolveMediaUrl: async () => 'https://media.example/private.mp4',
      },
    });

    await expect(service.openEVaultPreview({ eName: '@owner.w3id' }, 'cached-stream')).rejects.toBe(
      accessRevoked,
    );
    expect(inspectPlayableStream).toHaveBeenCalledWith(
      { eName: '@owner.w3id' },
      'cached-stream',
      expect.objectContaining({ priority: 'preview', signal: expect.anything() }),
    );
  });

  it('repairs a ready eVault preview when its cached media blob is missing', async () => {
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    const { service, store, storage } = createService();
    const staleStorageKey = storage.createStorageKey();
    await storage.write(staleStorageKey, jpeg);
    await store.create({
      id: 'missing-cached-preview',
      sourceKind: 'evault-file',
      sourceKey: 'w3ds://file?id=@owner.w3id/missing-cached-stream',
      storageKey: staleStorageKey,
      status: 'ready',
      contentType: 'image/jpeg',
      byteSize: jpeg.byteLength,
    });
    await storage.delete(staleStorageKey);

    await expect(
      service.openEVaultPreview({ eName: '@viewer.w3id' }, 'missing-cached-stream'),
    ).resolves.toEqual({ status: 'processing' });

    await vi.waitFor(async () => {
      const repaired = await store.getBySource(
        'evault-file',
        'w3ds://file?id=@owner.w3id/missing-cached-stream',
      );
      expect(repaired).toMatchObject({ status: 'ready' });
      expect(repaired?.storageKey).toBeDefined();
      expect(repaired?.storageKey).not.toBe(staleStorageKey);
    });
    expect(logs).toContainEqual(expect.stringContaining('"code":"preview_cached_blob_missing"'));
    expect(logs.join('\n')).not.toContain(staleStorageKey);

    const download = await service.openEVaultPreview(
      { eName: '@viewer.w3id' },
      'missing-cached-stream',
    );
    expect(download).toMatchObject({ status: 'ready', contentType: 'image/jpeg' });
    if (download.status === 'ready') expect(download.body).toEqual(jpeg);
  });

  it('uses a neutral poster when a queued eVault preview has no decodable frame', async () => {
    const { service, store } = createService({ extract: async () => undefined });

    await expect(
      service.openEVaultPreview({ eName: '@owner.w3id' }, 'frame-less'),
    ).resolves.toEqual({ status: 'processing' });
    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/frame-less'),
      ).resolves.toMatchObject({ status: 'failed' });
    });
    const download = await service.openEVaultPreview({ eName: '@owner.w3id' }, 'frame-less');

    expect(download).toMatchObject({ status: 'ready', contentType: 'image/svg+xml' });
    if (download.status === 'ready') {
      expect(new TextDecoder().decode(download.body)).toContain('<svg');
    }
  });

  it('marks true generation failure as unavailable rather than serving a broken image', async () => {
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    const { service, videos, media, storage } = createService({
      extract: async () => undefined,
    });
    const video = await seedOwnedDraft(videos, {
      id: 'video-owned',
      ownerId: 'user-1',
      title: 'IMG 1589',
    });
    media.registerOwnedDraft(video.id, 'user-1');
    const storageKey = storage.createStorageKey();
    await storage.write(storageKey, new Uint8Array([9]));
    await media.createAsset({
      id: 'media-1',
      ownerId: 'user-1',
      videoId: video.id,
      storageKey,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      byteSize: 1,
      uploadState: 'ready',
    });

    const download = await service.openOwnedPreview({ id: 'user-1' }, video.id);
    expect(download.status).toBe('unavailable');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"category":"video_preview"');
    expect(logs[0]).toContain('"code":"preview_no_decodable_frame"');
    expect(logs[0]).not.toContain(video.id);
    expect(logs[0]).not.toContain(storageKey);
  });

  it('records an accurate-seek recovery without exposing source details', async () => {
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    const { service, store } = createService({
      extract: async () => ({ jpeg, captureSeconds: 3, captureStrategy: 'accurate-seek' }),
    });

    await service.scheduleLibraryBackfill({ eName: '@viewer.w3id' }, [
      { streamIds: ['accurate-seek-source'] },
    ]);
    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/accurate-seek-source'),
      ).resolves.toMatchObject({ status: 'ready' });
    });

    expect(logs).toContainEqual(expect.stringContaining('"code":"preview_accurate_seek_fallback"'));
    expect(logs.join('\n')).not.toContain('accurate-seek-source');
  });

  it('keeps library poster URLs on the authorized evault preview path', () => {
    const { service } = createService();
    expect(
      service.describeLibraryPoster({ streamIds: ['grant-1'], previewState: 'processing' }),
    ).toEqual({
      state: 'processing',
      posterUrl: '/api/evault/videos/grant-1/preview',
    });
  });

  it('retries failed library previews during backfill', async () => {
    const store = new InMemoryVideoPreviewStore();
    const retrying = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      extractor: {
        extractUsefulFrame: async () => ({ jpeg, captureSeconds: 3 }),
      },
      evault: {
        inspectBoundStream: (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        inspectPlayableStream: async (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        resolveMediaUrl: async () => 'https://media.example/private.mp4',
      },
    });
    await store.create({
      id: 'preview-1',
      sourceKind: 'evault-file',
      sourceKey: 'w3ds://file?id=@owner.w3id/grant-1',
      status: 'failed',
    });

    await retrying.scheduleLibraryBackfill({ eName: '@owner.w3id' }, [{ streamIds: ['grant-1'] }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const record = await store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/grant-1');
    expect(record?.status).toBe('ready');
  });

  it('limits scheduled private-library preview work to one concurrent job', async () => {
    const store = new InMemoryVideoPreviewStore();
    let active = 0;
    let highestActive = 0;
    let release: (() => void) | undefined;
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      extractor: {
        extractUsefulFrame: async () => {
          active += 1;
          highestActive = Math.max(highestActive, active);
          await unblock;
          active -= 1;
          return { jpeg, captureSeconds: 3 };
        },
      },
      evault: {
        inspectBoundStream: (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        inspectPlayableStream: async (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        resolveMediaUrl: async (user, streamId) =>
          `https://media.example/${encodeURIComponent(user.eName)}/${streamId}.mp4`,
      },
    });

    await service.scheduleLibraryBackfill({ eName: '@owner.w3id' }, [
      { streamIds: ['one'] },
      { streamIds: ['two'] },
      { streamIds: ['three'] },
    ]);

    await vi.waitFor(() => expect(active).toBe(1));
    expect(highestActive).toBe(1);
    release?.();
    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/three'),
      ).resolves.toMatchObject({ status: 'ready' });
    });
    expect(highestActive).toBe(1);
  });

  it('renews a durable shared stream only when its queued task starts', async () => {
    const store = new InMemoryVideoPreviewStore();
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let extractions = 0;
    const evault = {
      renewCalls: 0,
      inspectBoundStream: (_user: { eName: string }, streamId: string) => ({
        fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
      }),
      inspectPlayableStream: async (_user: { eName: string }, streamId: string) => ({
        fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
      }),
      resolveMediaUrl: async () => 'https://media.example/private.mp4',
      // Keep this deliberately `this`-dependent. The production eVault
      // library method is too, and this catches any accidental detachment.
      renewPlayableStream(_user: { eName: string }, _retainedStreamId: string): Promise<string> {
        this.renewCalls += 1;
        return Promise.resolve('fresh-stream');
      },
    };
    const service = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      extractor: {
        extractUsefulFrame: async () => {
          extractions += 1;
          if (extractions === 1) {
            markFirstStarted();
            await release;
          }
          return { jpeg, captureSeconds: 3 };
        },
      },
      evault,
    });

    await service.scheduleLibraryBackfill({ eName: '@viewer.w3id' }, [
      { streamIds: ['blocking-stream'] },
    ]);
    await firstStarted;

    await service.scheduleDurableLibraryBackfill(
      { eName: '@viewer.w3id' },
      [{ streamIds: ['retained-expired-stream'] }],
      { retryFailed: true },
    );
    expect(evault.renewCalls).toBe(0);

    releaseFirst();
    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/fresh-stream'),
      ).resolves.toMatchObject({ status: 'ready' });
    });
    expect(evault.renewCalls).toBe(1);
  });

  it('uses a fallback poster until scheduled retry can repair a rate-limited eVault preview', async () => {
    const store = new InMemoryVideoPreviewStore();
    const service = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      extractor: { extractUsefulFrame: async () => ({ jpeg, captureSeconds: 3 }) },
      evault: {
        inspectBoundStream: (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        inspectPlayableStream: async (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        resolveMediaUrl: async () => {
          const error = Object.assign(new Error('rate limited'), { status: 429 });
          throw error;
        },
      },
    });
    await store.create({
      id: 'preview-rate-limit',
      sourceKind: 'evault-file',
      sourceKey: 'w3ds://file?id=@owner.w3id/grant-rate-limit',
      status: 'failed',
    });

    await expect(
      service.peekLibraryPreview({ eName: '@owner.w3id' }, 'grant-rate-limit'),
    ).resolves.toBe('unavailable');
    await expect(
      service.openEVaultPreview({ eName: '@owner.w3id' }, 'grant-rate-limit'),
    ).resolves.toMatchObject({ status: 'ready', contentType: 'image/svg+xml' });
    await service.scheduleLibraryBackfill({ eName: '@owner.w3id' }, [
      { streamIds: ['grant-rate-limit'] },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/grant-rate-limit'),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('keeps a retryable ffmpeg read pending instead of marking its preview unavailable', async () => {
    const store = new InMemoryVideoPreviewStore();
    const service = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      extractor: {
        extractUsefulFrame: async () => {
          throw new VideoFrameExtractorError('temporary source read failure', 'retryable');
        },
      },
      evault: {
        inspectBoundStream: (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        inspectPlayableStream: async (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        resolveMediaUrl: async () => 'https://media.example/private.mp4',
      },
      backfillRetryDelayMs: 60_000,
    });

    await service.scheduleLibraryBackfill({ eName: '@owner.w3id' }, [
      { streamIds: ['retryable-frame'] },
    ]);

    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/retryable-frame'),
      ).resolves.toMatchObject({ status: 'pending' });
    });
  });

  it('retries a retryable scheduled preview once without a second library request', async () => {
    const store = new InMemoryVideoPreviewStore();
    let resolves = 0;
    const service = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      extractor: { extractUsefulFrame: async () => ({ jpeg, captureSeconds: 3 }) },
      evault: {
        inspectBoundStream: (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        inspectPlayableStream: async (_user, streamId) => ({
          fileUri: `w3ds://file?id=@owner.w3id/${streamId}`,
        }),
        resolveMediaUrl: async () => {
          resolves += 1;
          if (resolves === 1) {
            const error = Object.assign(new Error('rate limited'), { status: 429 });
            throw error;
          }
          return 'https://media.example/private.mp4';
        },
      },
      backfillRetryDelayMs: 0,
    });

    await service.scheduleLibraryBackfill({ eName: '@owner.w3id' }, [
      { streamIds: ['retry-once'] },
    ]);

    await vi.waitFor(async () => {
      await expect(
        store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/retry-once'),
      ).resolves.toMatchObject({ status: 'ready' });
    });
    expect(resolves).toBe(2);
  });

  it('does not treat LocalDiskMediaStorage as a public URL surface', () => {
    expect(new LocalDiskMediaStorage('/tmp/vidak-preview-test').createStorageKey()).toMatch(
      /^media_/,
    );
  });

  it('replaces ephemeral thumbnail URLs with the authorized preview path', () => {
    const sanitized = sanitizeOwnedVideoForLibrary({
      id: 'video-owned',
      channelId: 'channel-1',
      title: 'friends with hats',
      description: '',
      thumbnailUrl: 'blob:https://vidak.postplatforms.com/abc',
      durationSeconds: 12,
      status: 'draft',
      visibility: 'private',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: [],
    });
    expect(sanitized.thumbnailUrl).toBe('/api/videos/owned/video-owned/preview');
    expect(sanitized.visibility).toBe('private');
    expect(sanitized.status).toBe('draft');
  });
});
