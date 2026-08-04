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
});
