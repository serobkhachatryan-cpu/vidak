import { createAuthUser } from '@w3ds/auth';
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

describe('public channel attribution and view counting', () => {
  it('joins the real creator channel on public cards and never Unknown channel', async () => {
    const store = new InMemoryCreatorVideoStore();
    let sequence = 0;
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: () => `id-${++sequence}`,
    });

    const draft = await service.createDraft('token', {
      title: 'Public talk',
      visibility: 'public',
    });
    expect(draft.channelId).toBeTruthy();
    store.seedReadyMediaAsset(draft.id);
    const published = await service.publishVideo('token', draft.id);
    expect(published.channelId).toBe(draft.channelId);

    const publicVideo = await service.getPublicVideo(published.publicVideoId ?? '');
    expect(publicVideo.channel).toMatchObject({
      id: draft.channelId,
      name: 'Ada Lovelace',
      handle: expect.stringContaining('ada'),
    });
    expect(JSON.stringify(publicVideo)).not.toMatch(/Unknown channel/i);
    expect(JSON.stringify(publicVideo.channel)).not.toMatch(/eName|evault|jwt|token/i);

    const listed = await service.listPublicVideos();
    expect(listed.items[0]?.channel?.name).toBe('Ada Lovelace');
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
