import { describe, expect, it } from 'vitest';
import { MockVideoApiClient } from './mock-video-client.js';

describe('MockVideoApiClient', () => {
  const client = new MockVideoApiClient();

  it('filters video pages and returns an opaque next cursor', async () => {
    const firstPage = await client.listVideos({ status: 'published' }, { limit: 1 });
    const secondPage = await client.listVideos(
      { status: 'published' },
      { cursor: firstPage.nextCursor, limit: 1 },
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

  it('returns undefined for an unknown resource', async () => {
    await expect(client.getVideo('missing-video')).resolves.toBeUndefined();
  });
});
