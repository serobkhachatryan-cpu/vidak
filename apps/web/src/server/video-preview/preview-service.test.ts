import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { InMemoryCreatorVideoStore } from '../creator-video-store';
import { InMemoryMediaAssetStore } from '../media-asset-store';
import {
  LocalDiskMediaStorage,
  type MediaStorage,
  MediaStorageError,
  type MediaUploadSession,
} from '../media-storage';
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
  extract?: () => Promise<{ jpeg: Uint8Array; captureSeconds: number } | undefined>;
  evaultUrl?: string;
}) {
  const videos = new InMemoryCreatorVideoStore();
  const media = new InMemoryMediaAssetStore();
  const storage = new MemoryMediaStorage();
  const service = new VideoPreviewService({
    store: new InMemoryVideoPreviewStore(),
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
      inspectStream: (_user, streamId) => {
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
  return { service, videos, media, storage };
}

describe('VideoPreviewService', () => {
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

  it('marks true generation failure as unavailable rather than serving a broken image', async () => {
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
        inspectStream: (_user, streamId) => ({
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

  it('keeps rate-limited eVault previews retryable through the visible-card path', async () => {
    const store = new InMemoryVideoPreviewStore();
    const service = new VideoPreviewService({
      store,
      storage: new MemoryMediaStorage(),
      videos: new InMemoryCreatorVideoStore(),
      media: new InMemoryMediaAssetStore(),
      extractor: { extractUsefulFrame: async () => ({ jpeg, captureSeconds: 3 }) },
      evault: {
        inspectStream: (_user, streamId) => ({
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
    ).resolves.toBe('processing');
    await expect(
      service.openEVaultPreview({ eName: '@owner.w3id' }, 'grant-rate-limit'),
    ).resolves.toEqual({ status: 'processing' });
    await expect(
      store.getBySource('evault-file', 'w3ds://file?id=@owner.w3id/grant-rate-limit'),
    ).resolves.toMatchObject({ status: 'pending' });
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
