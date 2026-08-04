import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaAssetError } from './media-asset-errors';
import { InMemoryMediaAssetStore } from './media-asset-store';
import { assertSafeStorageKey, LocalDiskMediaStorage, MediaStorageError } from './media-storage';

const ownerId = 'user-owner';
const otherOwnerId = 'user-other';
const videoId = 'video-draft-1';

function createStoreWithDraft(): InMemoryMediaAssetStore {
  const store = new InMemoryMediaAssetStore();
  store.registerOwnedDraft(videoId, ownerId);
  return store;
}

describe('InMemoryMediaAssetStore', () => {
  it('creates, reads, lists, updates, and deletes owned media assets', async () => {
    const store = createStoreWithDraft();
    const created = await store.createAsset({
      id: 'asset-1',
      ownerId,
      videoId,
      storageKey: 'media_11111111-1111-4111-8111-111111111111',
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      byteSize: 1024,
    });

    expect(created).toMatchObject({
      id: 'asset-1',
      ownerId,
      videoId,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      byteSize: 1024,
      uploadState: 'pending',
    });
    expect(created.storageKey).toBe('media_11111111-1111-4111-8111-111111111111');

    await expect(store.getOwnedAsset('asset-1', ownerId)).resolves.toMatchObject({
      id: 'asset-1',
      uploadState: 'pending',
    });
    await expect(store.listOwnedAssetsByVideoId(videoId, ownerId)).resolves.toEqual([created]);

    const updated = await store.updateUploadState('asset-1', ownerId, 'ready');
    expect(updated).toMatchObject({ id: 'asset-1', uploadState: 'ready' });

    const deleted = await store.deleteOwnedAsset('asset-1', ownerId);
    expect(deleted).toMatchObject({ id: 'asset-1', storageKey: created.storageKey });
    await expect(store.getOwnedAsset('asset-1', ownerId)).resolves.toBeUndefined();
    await expect(store.listOwnedAssetsByVideoId(videoId, ownerId)).resolves.toEqual([]);
  });

  it('enforces draft ownership on create and hides cross-user access', async () => {
    const store = createStoreWithDraft();

    await expect(
      store.createAsset({
        id: 'asset-x',
        ownerId: otherOwnerId,
        videoId,
        storageKey: 'media_22222222-2222-4222-8222-222222222222',
        originalFilename: 'steal.mp4',
        contentType: 'video/mp4',
        byteSize: 10,
      }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });

    await expect(
      store.createAsset({
        id: 'asset-missing-draft',
        ownerId,
        videoId: 'missing-draft',
        storageKey: 'media_33333333-3333-4333-8333-333333333333',
        originalFilename: 'ghost.mp4',
        contentType: 'video/mp4',
        byteSize: 10,
      }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });

    const created = await store.createAsset({
      id: 'asset-owned',
      ownerId,
      videoId,
      storageKey: 'media_44444444-4444-4444-8444-444444444444',
      originalFilename: 'mine.mp4',
      contentType: 'video/mp4',
      byteSize: 20,
    });

    await expect(store.getOwnedAsset(created.id, otherOwnerId)).resolves.toBeUndefined();
    await expect(store.listOwnedAssetsByVideoId(videoId, otherOwnerId)).resolves.toEqual([]);
    await expect(
      store.updateUploadState(created.id, otherOwnerId, 'failed'),
    ).resolves.toBeUndefined();
    await expect(store.deleteOwnedAsset(created.id, otherOwnerId)).resolves.toBeUndefined();
    await expect(store.getOwnedAsset(created.id, ownerId)).resolves.toMatchObject({
      id: created.id,
      uploadState: 'pending',
    });
  });

  it('rejects unsafe storage keys and invalid metadata', async () => {
    const store = createStoreWithDraft();

    await expect(
      store.createAsset({
        id: 'asset-bad-key',
        ownerId,
        videoId,
        storageKey: '../etc/passwd',
        originalFilename: 'x.mp4',
        contentType: 'video/mp4',
        byteSize: 1,
      }),
    ).rejects.toBeInstanceOf(MediaStorageError);

    await expect(
      store.createAsset({
        id: 'asset-bad-size',
        ownerId,
        videoId,
        storageKey: 'media_55555555-5555-4555-8555-555555555555',
        originalFilename: 'x.mp4',
        contentType: 'video/mp4',
        byteSize: -1,
      }),
    ).rejects.toBeInstanceOf(MediaAssetError);

    await expect(
      store.updateUploadState('missing', ownerId, 'not-a-state' as never),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 400 });
  });

  it('rejects duplicate storage keys', async () => {
    const store = createStoreWithDraft();
    const storageKey = 'media_66666666-6666-4666-8666-666666666666';
    await store.createAsset({
      id: 'asset-a',
      ownerId,
      videoId,
      storageKey,
      originalFilename: 'a.mp4',
      contentType: 'video/mp4',
      byteSize: 1,
    });

    await expect(
      store.createAsset({
        id: 'asset-b',
        ownerId,
        videoId,
        storageKey,
        originalFilename: 'b.mp4',
        contentType: 'video/mp4',
        byteSize: 2,
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});

describe('LocalDiskMediaStorage', () => {
  let rootDir: string;
  let storage: LocalDiskMediaStorage;

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  async function createTempStorage(): Promise<LocalDiskMediaStorage> {
    rootDir = await mkdtemp(join(tmpdir(), 'vidak-media-'));
    storage = new LocalDiskMediaStorage(rootDir);
    return storage;
  }

  it('generates opaque keys and round-trips object bytes', async () => {
    const disk = await createTempStorage();
    const key = disk.createStorageKey();
    expect(() => assertSafeStorageKey(key)).not.toThrow();
    expect(key.includes('/')).toBe(false);
    expect(key.includes('..')).toBe(false);

    const payload = new TextEncoder().encode('durable-bytes');
    await disk.write(key, payload);
    await expect(disk.exists(key)).resolves.toBe(true);
    await expect(disk.read(key)).resolves.toEqual(payload);

    const path = disk.resolveObjectPath(key);
    expect(path.startsWith(rootDir)).toBe(true);
    expect(path.includes(`${join('..')}`)).toBe(false);
  });

  it('rejects path-traversal and non-opaque storage keys', async () => {
    const disk = await createTempStorage();
    const unsafeKeys = [
      '../secret',
      '..\\secret',
      '/etc/passwd',
      'foo/bar',
      'media_../../../etc/passwd',
      'not-a-uuid',
      '',
    ];

    for (const key of unsafeKeys) {
      expect(() => assertSafeStorageKey(key)).toThrow(MediaStorageError);
      await expect(disk.write(key, new Uint8Array([1]))).rejects.toBeInstanceOf(MediaStorageError);
      await expect(disk.read(key)).rejects.toBeInstanceOf(MediaStorageError);
      await expect(disk.exists(key)).rejects.toBeInstanceOf(MediaStorageError);
      await expect(disk.delete(key)).rejects.toBeInstanceOf(MediaStorageError);
    }
  });

  it('supports cleanup by deleting stored objects', async () => {
    const disk = await createTempStorage();
    const store = createStoreWithDraft();
    const key = disk.createStorageKey();

    await disk.write(key, new Uint8Array([9, 8, 7]));
    const asset = await store.createAsset({
      id: 'asset-cleanup',
      ownerId,
      videoId,
      storageKey: key,
      originalFilename: 'cleanup.bin',
      contentType: 'application/octet-stream',
      byteSize: 3,
      uploadState: 'ready',
    });

    const deleted = await store.deleteOwnedAsset(asset.id, ownerId);
    expect(deleted).toBeDefined();
    expect(deleted?.storageKey).toBe(key);
    await disk.delete(key);
    await expect(disk.exists(key)).resolves.toBe(false);
    await expect(disk.read(key)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('streams uploads through temporary storage then finalizes', async () => {
    const disk = await createTempStorage();
    const upload = await disk.openUpload();
    await upload.write(new TextEncoder().encode('hello '));
    await upload.write(new TextEncoder().encode('world'));
    expect(upload.bytesWritten).toBe(11);

    const finalKey = disk.createStorageKey();
    await upload.finalize(finalKey);
    await expect(disk.exists(finalKey)).resolves.toBe(true);
    await expect(disk.read(finalKey)).resolves.toEqual(new TextEncoder().encode('hello world'));

    const stream = await disk.openReadStream(finalKey);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const merged = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    expect(merged.toString('utf8')).toBe('hello world');
  });

  it('aborts temporary uploads without leaving final objects', async () => {
    const disk = await createTempStorage();
    const upload = await disk.openUpload();
    await upload.write(new Uint8Array([1, 2, 3]));
    await upload.abort();
    const finalKey = disk.createStorageKey();
    await expect(disk.exists(finalKey)).resolves.toBe(false);
  });
});
