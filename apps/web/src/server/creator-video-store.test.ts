import { beforeEach, describe, expect, it } from 'vitest';
import { CreatorVideoError } from './creator-video-errors';
import { InMemoryCreatorVideoStore } from './creator-video-store';

const ownerId = 'user-owner';
const otherOwnerId = 'user-other';

describe('InMemoryCreatorVideoStore publish lifecycle', () => {
  let store: InMemoryCreatorVideoStore;
  let videoId: string;

  beforeEach(async () => {
    store = new InMemoryCreatorVideoStore();
    const channel = await store.findOrCreateChannel({
      id: 'channel-1',
      ownerId,
      handle: 'owner',
      name: 'Owner',
    });
    const draft = await store.createDraft({
      id: 'video-1',
      channelId: channel.id,
      ownerId,
      title: 'Cache tutorial',
      description: 'How caching works',
      tags: ['cache'],
      visibility: 'unlisted',
      thumbnailUrl: '',
    });
    videoId = draft.id;
  });

  it('publishes an owned draft with a ready media asset and assigns publishing metadata', async () => {
    store.seedReadyMediaAsset(videoId);
    const before = await store.getOwnedDraft(videoId, ownerId);
    expect(before).toMatchObject({
      status: 'draft',
      visibility: 'unlisted',
      createdAt: expect.any(String),
    });
    expect(before?.publicVideoId).toBeUndefined();
    expect(before?.publishedAt).toBeUndefined();

    const published = await store.publishOwnedVideo(videoId, ownerId, 'pub_stable-1');
    expect(published).toMatchObject({
      id: videoId,
      status: 'published',
      visibility: 'unlisted',
      publicVideoId: 'pub_stable-1',
      title: 'Cache tutorial',
      createdAt: before?.createdAt,
    });
    expect(published.publishedAt).toEqual(expect.any(String));
    expect(published.updatedAt >= (before?.updatedAt ?? '')).toBe(true);

    // Draft APIs no longer see the published row.
    await expect(store.getOwnedDraft(videoId, ownerId)).resolves.toBeUndefined();
    await expect(store.listDraftsByOwnerId(ownerId)).resolves.toEqual([]);
  });

  it('rejects publish without a ready media asset', async () => {
    await expect(store.publishOwnedVideo(videoId, ownerId, 'pub_x')).rejects.toMatchObject({
      code: 'precondition_failed',
      status: 409,
      message: 'Video cannot be published without at least one ready media asset.',
    });
    await expect(store.getOwnedDraft(videoId, ownerId)).resolves.toMatchObject({
      status: 'draft',
    });
  });

  it('rejects publish for missing or non-owned videos', async () => {
    store.seedReadyMediaAsset(videoId);
    await expect(
      store.publishOwnedVideo(videoId, otherOwnerId, 'pub_steal'),
    ).rejects.toBeInstanceOf(CreatorVideoError);
    await expect(store.publishOwnedVideo(videoId, otherOwnerId, 'pub_steal')).rejects.toMatchObject(
      {
        code: 'not_found',
        status: 404,
      },
    );
    await expect(
      store.publishOwnedVideo('missing-video', ownerId, 'pub_missing'),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('is idempotent for publish and preserves publishing metadata', async () => {
    store.seedReadyMediaAsset(videoId);
    const first = await store.publishOwnedVideo(videoId, ownerId, 'pub_first');
    const second = await store.publishOwnedVideo(videoId, ownerId, 'pub_second');

    expect(second).toEqual(first);
    expect(second.publicVideoId).toBe('pub_first');
    expect(second.publishedAt).toBe(first.publishedAt);
    expect(second.visibility).toBe('unlisted');
  });

  it('unpublishes back to draft while preserving ownership, visibility, and publicVideoId', async () => {
    store.seedReadyMediaAsset(videoId);
    const published = await store.publishOwnedVideo(videoId, ownerId, 'pub_keep');
    const unpublished = await store.unpublishOwnedVideo(videoId, ownerId);

    expect(unpublished).toMatchObject({
      id: videoId,
      status: 'draft',
      visibility: 'unlisted',
      publicVideoId: 'pub_keep',
      title: 'Cache tutorial',
      createdAt: published.createdAt,
    });
    expect(unpublished.publishedAt).toBeUndefined();
    await expect(store.getOwnedDraft(videoId, ownerId)).resolves.toMatchObject({
      id: videoId,
      status: 'draft',
      publicVideoId: 'pub_keep',
    });
  });

  it('is idempotent for unpublish of an already-draft video', async () => {
    const first = await store.unpublishOwnedVideo(videoId, ownerId);
    const second = await store.unpublishOwnedVideo(videoId, ownerId);
    expect(second).toEqual(first);
    expect(second.status).toBe('draft');
    expect(second.publishedAt).toBeUndefined();
  });

  it('republishes with the same publicVideoId and a fresh publishedAt', async () => {
    store.seedReadyMediaAsset(videoId);
    const first = await store.publishOwnedVideo(videoId, ownerId, 'pub_stable');
    await store.unpublishOwnedVideo(videoId, ownerId);

    // Ensure publishedAt advances on republish.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await store.publishOwnedVideo(videoId, ownerId, 'pub_other');

    expect(again.publicVideoId).toBe('pub_stable');
    expect(again.status).toBe('published');
    expect(again.publishedAt).toEqual(expect.any(String));
    expect(again.publishedAt).not.toBe(first.publishedAt);
    expect(again.visibility).toBe('unlisted');
  });

  it('rejects unpublish for non-owned videos', async () => {
    store.seedReadyMediaAsset(videoId);
    await store.publishOwnedVideo(videoId, ownerId, 'pub_owned');
    await expect(store.unpublishOwnedVideo(videoId, otherOwnerId)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});
