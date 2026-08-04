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
