import { createAuthUser } from '@w3ds/auth';
import { NEUTRAL_PUBLIC_CHANNEL_NAME } from '@w3ds/types';
import { describe, expect, it } from 'vitest';
import { CreatorVideoService, InMemoryCreatorVideoStore } from './creator-video';
import { hashPublicViewerKey, PUBLIC_VIEW_DEDUP_WINDOW_MS } from './public-video-views';

const owner = createAuthUser({
  id: 'user-owner',
  displayName: 'Ada Lovelace',
  roles: ['creator'],
  eName: '@owner.w3id',
  eVaultId: 'evault-owner',
  handle: 'ada',
});

const opaqueUuid = 'fd10387a-b0d3-5f9c-bf54-7214a491cace';
const localId = `w3ds_${opaqueUuid}`;
const productionHandle = 'fd10387a-b0d3-5f9c-bf54-7214a491-w3ds450ac914';

async function publishPublicTalk(store: InMemoryCreatorVideoStore, service: CreatorVideoService) {
  const draft = await service.createDraft('token', {
    title: 'Public talk',
    visibility: 'public',
  });
  store.seedReadyMediaAsset(draft.id);
  return service.publishVideo('token', draft.id);
}

describe('public channel attribution and view counting', () => {
  it('joins the real creator channel on public cards and never Unknown channel', async () => {
    const store = new InMemoryCreatorVideoStore();
    let sequence = 0;
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: () => `id-${++sequence}`,
    });

    const published = await publishPublicTalk(store, service);
    expect(published.channelId).toBeTruthy();

    const publicVideo = await service.getPublicVideo(published.publicVideoId ?? '');
    expect(publicVideo.channel).toMatchObject({
      id: published.channelId,
      name: 'Ada Lovelace',
      handle: 'ada',
    });
    expect(JSON.stringify(publicVideo)).not.toMatch(/Unknown channel/i);
    expect(JSON.stringify(publicVideo.channel)).not.toMatch(/eName|evault|jwt|token/i);

    const listed = await service.listPublicVideos();
    expect(listed.items[0]?.channel?.name).toBe('Ada Lovelace');

    const channels = await service.listPublicChannels({ query: 'Ada' });
    expect(channels.items).toEqual([
      expect.objectContaining({ name: 'Ada Lovelace', handle: 'ada' }),
    ]);
  });

  it('omits channels that only have unpublished drafts from public discovery', async () => {
    const store = new InMemoryCreatorVideoStore();
    let sequence = 0;
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: () => `id-${++sequence}`,
    });

    await service.createDraft('token', {
      title: 'Unpublished draft',
      visibility: 'public',
    });
    await expect(service.listPublicChannels()).resolves.toEqual({ items: [] });
  });

  it('never publishes UUID, eName, or local-id channel labels', async () => {
    const store = new InMemoryCreatorVideoStore();
    const channel = await store.findOrCreateChannel({
      id: 'channel-technical',
      ownerId: owner.id,
      handle: productionHandle,
      name: opaqueUuid,
    });
    store.seedOwnerDisplayName(owner.id, 'Ada Lovelace');
    const draft = await store.createDraft({
      id: 'video-technical',
      channelId: channel.id,
      ownerId: owner.id,
      title: 'Hats',
      description: '',
      tags: [],
      visibility: 'public',
      thumbnailUrl: '',
    });
    store.seedReadyMediaAsset(draft.id);
    const published = await store.publishOwnedVideo(draft.id, owner.id, 'pub_hats');
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: () => 'id-1',
    });

    const publicVideo = await service.getPublicVideo(published.publicVideoId ?? '');
    expect(publicVideo.channel?.name).toBe('Ada Lovelace');
    expect(publicVideo.channel?.handle).toBe('');
    expect(JSON.stringify(publicVideo)).not.toContain(opaqueUuid);
    expect(JSON.stringify(publicVideo)).not.toContain(localId);
    expect(JSON.stringify(publicVideo)).not.toContain(productionHandle);
    expect(JSON.stringify(publicVideo)).not.toMatch(/Unknown channel/i);

    const publicChannel = await service.getPublicChannel(channel.id);
    expect(publicChannel.name).toBe('Ada Lovelace');
    expect(publicChannel.handle).toBe('');
    expect(publicChannel.name).not.toBe(opaqueUuid);
  });

  it('uses Vidak channel when the owner has no chosen public name', async () => {
    const store = new InMemoryCreatorVideoStore();
    await store.findOrCreateChannel({
      id: 'channel-ename',
      ownerId: localId,
      handle: `@${opaqueUuid}`,
      name: `@${opaqueUuid}`,
    });
    const service = new CreatorVideoService({
      store,
      resolveUser: async () =>
        createAuthUser({
          id: localId,
          displayName: '@creator.w3id',
          roles: ['creator'],
          eName: `@${opaqueUuid}`,
          eVaultId: 'evault-creator',
        }),
      createId: () => 'id-1',
    });
    const publicChannel = await service.getPublicChannel('channel-ename');
    expect(publicChannel.name).toBe(NEUTRAL_PUBLIC_CHANNEL_NAME);
    expect(publicChannel.handle).toBe('');
    expect(publicChannel.name).not.toBe(`@${opaqueUuid}`);
  });

  it('does not overwrite a genuinely chosen channel name', async () => {
    const store = new InMemoryCreatorVideoStore();
    await store.findOrCreateChannel({
      id: 'channel-chosen',
      ownerId: owner.id,
      handle: 'cooking-ada',
      name: 'Cooking with Ada',
    });
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: () => 'id-1',
    });
    const channel = await service.ensureCreatorChannel('token');
    expect(channel.name).toBe('Cooking with Ada');
  });

  it('counts a meaningful playback once and ignores refresh/replay inside the window', async () => {
    const store = new InMemoryCreatorVideoStore();
    let sequence = 0;
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: () => `id-${++sequence}`,
    });
    const draft = await service.createDraft('token', { title: 'Views', visibility: 'public' });
    store.seedReadyMediaAsset(draft.id);
    const published = await service.publishVideo('token', draft.id);
    const publicVideoId = published.publicVideoId ?? '';
    const viewerKey = hashPublicViewerKey({
      pepper: 'test',
      publicVideoId,
      clientAddress: '203.0.113.10',
      userAgent: 'VidakTest/1.0',
    });
    expect(viewerKey).toMatch(/^[a-f0-9]{64}$/);
    expect(viewerKey).not.toContain('203.0.113.10');

    const first = await service.recordPublicView(publicVideoId, viewerKey);
    expect(first.counted).toBe(true);
    expect(first.video.viewCount).toBe(1);
    expect(first.video.visibility).toBe('public');
    expect(first.video.channel?.name).toBe('Ada Lovelace');

    const refresh = await service.recordPublicView(publicVideoId, viewerKey);
    expect(refresh.counted).toBe(false);
    expect(refresh.video.viewCount).toBe(1);

    const replay = await service.recordPublicView(publicVideoId, viewerKey);
    expect(replay.counted).toBe(false);
    expect(replay.video.viewCount).toBe(1);

    const afterWindow = await service.recordPublicView(
      publicVideoId,
      viewerKey,
      new Date(Date.now() + PUBLIC_VIEW_DEDUP_WINDOW_MS + 1_000),
    );
    expect(afterWindow.counted).toBe(true);
    expect(afterWindow.video.viewCount).toBe(2);
  });

  it('treats concurrent duplicate views as a single atomic increment', async () => {
    const store = new InMemoryCreatorVideoStore();
    let sequence = 0;
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: () => `id-${++sequence}`,
    });
    const draft = await service.createDraft('token', { title: 'Atomic', visibility: 'public' });
    store.seedReadyMediaAsset(draft.id);
    const published = await service.publishVideo('token', draft.id);
    const publicVideoId = published.publicVideoId ?? '';
    const viewerKey = 'abc'.repeat(21).slice(0, 64);

    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.recordPublicView(publicVideoId, viewerKey)),
    );
    const counted = results.filter((result) => result.counted);
    expect(counted).toHaveLength(1);
    expect(results.every((result) => result.video.viewCount === 1)).toBe(true);
    await expect(service.getPublicVideo(publicVideoId)).resolves.toMatchObject({ viewCount: 1 });
  });
});
