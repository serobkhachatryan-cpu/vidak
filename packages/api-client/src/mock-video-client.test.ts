import { describe, expect, it } from 'vitest';
import { MockVideoApiClient } from './mock-video-client';

describe('MockVideoApiClient', () => {
  const client = new MockVideoApiClient();

  it('filters video pages and returns an opaque next cursor', async () => {
    const firstPage = await client.listVideos({ status: 'published' }, { limit: 1 });
    const secondPage = await client.listVideos(
      { status: 'published' },
      { ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}), limit: 1 },
    );

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBe('offset:1');
    expect(secondPage.items[0]?.id).toBe('video-query-caching');
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('matches video search terms across titles, descriptions, and tags', async () => {
    const page = await client.listVideos({ search: 'ACCESSIBILITY' });

    expect(page.items.map((video) => video.id)).toEqual(['video-accessible-player']);
  });

  it('searches channels and playlists and sorts videos by views', async () => {
    const channels = await client.listChannels({ query: 'studio' });
    const playlists = await client.listPlaylists({ query: 'platform' });
    const videos = await client.listVideos({ sort: 'views' });

    expect(channels.items.map((channel) => channel.id)).toEqual(['channel-studio']);
    expect(playlists.items.map((playlist) => playlist.id)).toEqual(['playlist-foundations']);
    expect(videos.items[0]?.id).toBe('video-design-system');
  });

  it('lists only top-level comments for a video', async () => {
    const page = await client.listComments('video-design-system');

    expect(page.items.map((comment) => comment.id)).toEqual(['comment-1', 'comment-3']);
  });

  it('sorts comments and loads nested replies independently', async () => {
    const newest = await client.listComments('video-design-system', { sort: 'newest' });
    const replies = await client.listComments('video-design-system', { parentId: 'comment-1' });

    expect(newest.items.map((comment) => comment.id)).toEqual(['comment-3', 'comment-1']);
    expect(replies.items.map((comment) => comment.id)).toEqual(['comment-2']);
  });

  it('creates replies and records comment reactions', async () => {
    const reply = await client.createComment('video-design-system', {
      parentId: 'comment-1',
      body: 'Thanks for the walkthrough.',
    });
    const reacted = await client.reactToComment('comment-1', 'like');
    const parent = await client.listComments('video-design-system');

    expect(reply.parentId).toBe('comment-1');
    expect(parent.items[0]?.replyCount).toBe(2);
    expect(reacted.viewerReaction).toBe('like');
    expect(reacted.likeCount).toBe(43);
  });

  it('returns undefined for an unknown resource', async () => {
    await expect(client.getVideo('missing-video')).resolves.toBeUndefined();
  });

  it('uploads a video with progress and creates a published video', async () => {
    const progress: number[] = [];
    const upload = await client.uploadVideo(
      { name: 'demo.mp4', size: 1_000_000, type: 'video/mp4' },
      { onProgress: (event) => progress.push(event.percent) },
    );
    const video = await client.createVideo({
      channelId: 'channel-studio',
      uploadId: upload.uploadId,
      title: 'New upload',
      description: 'Fresh from the studio',
      tags: ['demo'],
      category: 'education',
      language: 'en',
      visibility: 'public',
      thumbnailUrl: upload.autoThumbnails[0] ?? '',
      status: 'published',
    });

    expect(upload.uploadId).toMatch(/^upload-/);
    expect(upload.autoThumbnails.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(100);
    expect(video.status).toBe('published');
    expect(video.publishedAt).toBeDefined();
    expect(video.category).toBe('education');
    await expect(client.getVideo(video.id)).resolves.toMatchObject({ title: 'New upload' });
  });

  it('cancels an in-flight upload when aborted', async () => {
    const controller = new AbortController();
    const uploadPromise = client.uploadVideo(
      { name: 'large.mp4', size: 50_000_000, type: 'video/mp4' },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(uploadPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uploads, reads, and deletes draft media assets with progress', async () => {
    const draftClient = new MockVideoApiClient({ delayMs: 0 });
    const draft = await draftClient.createDraft({ title: 'Media draft' });
    const progress: number[] = [];
    const body = new Blob(['mock-bytes'], { type: 'video/mp4' });
    const asset = await draftClient.uploadDraftMedia(
      draft.id,
      { name: 'clip.mp4', size: body.size, type: 'video/mp4', body },
      { onProgress: (event) => progress.push(event.percent) },
    );

    expect(asset).toMatchObject({
      videoId: draft.id,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      uploadState: 'ready',
    });
    expect(asset).not.toHaveProperty('storageKey');
    expect(progress.at(-1)).toBe(100);
    expect(draftClient.draftMediaContentPath(draft.id, asset.id)).toBe(
      `/api/videos/drafts/${draft.id}/media/${asset.id}/content`,
    );
    await expect(draftClient.getDraftMedia(draft.id, asset.id)).resolves.toMatchObject({
      id: asset.id,
    });
    await draftClient.deleteDraftMedia(draft.id, asset.id);
    await expect(draftClient.getDraftMedia(draft.id, asset.id)).rejects.toThrow(/was not found/i);
  });

  it('creates and manages draft videos without changing createVideo publish behavior', async () => {
    const draftClient = new MockVideoApiClient({ delayMs: 0 });
    const draft = await draftClient.createDraft({
      title: 'Untitled draft',
      description: 'Metadata only',
      tags: ['draft'],
      category: 'education',
      language: 'en',
      visibility: 'private',
    });
    expect(draft.status).toBe('draft');
    expect(draft.publishedAt).toBeUndefined();

    const listed = await draftClient.listDrafts();
    expect(listed.some((item) => item.id === draft.id)).toBe(true);

    const updated = await draftClient.updateDraft(draft.id, { title: 'Named draft' });
    expect(updated.title).toBe('Named draft');
    expect(updated.status).toBe('draft');

    await draftClient.deleteDraft(draft.id);
    await expect(draftClient.getDraft(draft.id)).rejects.toThrow(/was not found/i);

    const upload = await draftClient.uploadVideo({
      name: 'clip.mp4',
      size: 1_024,
      type: 'video/mp4',
    });
    const published = await draftClient.createVideo({
      channelId: 'channel-studio',
      uploadId: upload.uploadId,
      title: 'Still publishable',
      description: 'Mock createVideo unchanged',
      tags: [],
      category: 'education',
      language: 'en',
      visibility: 'public',
      thumbnailUrl: 'https://example.com/a.jpg',
      status: 'published',
    });
    expect(published.status).toBe('published');
    expect(published.publishedAt).toBeTruthy();
  });

  it('publishes and unpublishes drafts with ready media and exposes public discovery', async () => {
    const publishClient = new MockVideoApiClient({ delayMs: 0, videos: [] });
    const draft = await publishClient.createDraft({
      title: 'Ready to ship',
      visibility: 'public',
    });
    await expect(publishClient.publishVideo(draft.id)).rejects.toThrow(/ready media/i);

    const body = new Blob(['bytes'], { type: 'video/mp4' });
    await publishClient.uploadDraftMedia(draft.id, {
      name: 'clip.mp4',
      size: body.size,
      type: 'video/mp4',
      body,
    });
    const published = await publishClient.publishVideo(draft.id);
    expect(published).toMatchObject({
      status: 'published',
      visibility: 'public',
      publicVideoId: expect.stringMatching(/^pub_/),
    });
    expect(published.publishedAt).toEqual(expect.any(String));

    const listed = await publishClient.listPublicVideos({ limit: 10 });
    expect(listed.items.map((item) => item.publicVideoId)).toContain(published.publicVideoId);

    const publicVideo = await publishClient.getPublicVideo(published.publicVideoId ?? '');
    expect(publicVideo?.title).toBe('Ready to ship');

    const mediaPath = await publishClient.resolvePublicMediaContentPath(
      published.publicVideoId ?? '',
    );
    expect(mediaPath).toBe(`/api/videos/public/${published.publicVideoId}/media`);
    expect(publicVideo?.mediaContentUrl).toBe(mediaPath);

    const unpublished = await publishClient.unpublishVideo(draft.id);
    expect(unpublished.status).toBe('draft');
    expect(unpublished.publicVideoId).toBe(published.publicVideoId);
    expect(unpublished.publishedAt).toBeUndefined();
    await expect(
      publishClient.getPublicVideo(published.publicVideoId ?? ''),
    ).resolves.toBeUndefined();
  });

  it('keeps unlisted published videos out of discovery but resolvable by public id', async () => {
    const client = new MockVideoApiClient({ delayMs: 0, videos: [] });
    const draft = await client.createDraft({ title: 'Link only', visibility: 'unlisted' });
    const body = new Blob(['bytes'], { type: 'video/mp4' });
    await client.uploadDraftMedia(draft.id, {
      name: 'clip.mp4',
      size: body.size,
      type: 'video/mp4',
      body,
    });
    const published = await client.publishVideo(draft.id);
    const discovery = await client.listPublicVideos();
    expect(discovery.items.map((item) => item.publicVideoId)).not.toContain(
      published.publicVideoId,
    );
    await expect(client.getPublicVideo(published.publicVideoId ?? '')).resolves.toMatchObject({
      visibility: 'unlisted',
      status: 'published',
    });
  });

  it('updates profile preferences and connected accounts', async () => {
    const profile = await client.updateUserProfile('user-demo', {
      displayName: 'Demo Creator',
      handle: 'demo-creator',
      bio: 'Updated bio',
    });
    expect(profile.bio).toBe('Updated bio');

    const preferences = await client.updateUserPreferences('user-demo', {
      appearance: 'dark',
      notifications: { emailMarketing: true },
    });
    expect(preferences.appearance).toBe('dark');
    expect(preferences.notifications.emailMarketing).toBe(true);

    const connected = await client.connectAccount('user-demo', 'github');
    expect(connected.find((account) => account.provider === 'github')?.connected).toBe(true);
    const disconnected = await client.disconnectAccount('user-demo', 'github');
    expect(disconnected.find((account) => account.provider === 'github')?.connected).toBe(false);
  });
});
