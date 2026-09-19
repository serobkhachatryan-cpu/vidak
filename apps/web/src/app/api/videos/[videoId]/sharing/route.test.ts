import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getSharingService: vi.fn(),
}));

vi.mock('../../../../../server/video-sharing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/video-sharing')>()),
  getVideoSharingService: mocks.getSharingService,
}));

import { GET, PUT } from './route';

describe('owner video sharing route', () => {
  beforeEach(() => {
    mocks.getSharingService.mockReset();
  });

  it('never caches an owner policy, including its private share locator', async () => {
    const unauthenticated = await GET(
      new NextRequest('https://vidak.example/api/videos/video-1/sharing'),
      { params: Promise.resolve({ videoId: 'video-1' }) },
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('cache-control')).toBe('private, no-store');

    mocks.getSharingService.mockReturnValue({
      getOwnerPolicy: vi.fn().mockResolvedValue({
        audience: 'people',
        readerENames: ['@friend.w3id'],
        groupENames: [],
        shareUrl: '/watch/shared/share_private-locator',
        video: {
          id: 'video-1',
          title: 'Private cut',
          status: 'published',
          visibility: 'private',
        },
      }),
    });
    const authorized = await GET(
      new NextRequest('https://vidak.example/api/videos/video-1/sharing', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ videoId: 'video-1' }) },
    );

    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('cache-control')).toBe('private, no-store');
    await expect(authorized.json()).resolves.toMatchObject({
      video: { id: 'video-1', title: 'Private cut', status: 'published' },
    });
  });

  it('accepts the explicit link-only audience and returns the canonical watch link', async () => {
    const updateOwnerPolicy = vi.fn().mockResolvedValue({
      audience: 'unlisted',
      readerENames: [],
      groupENames: [],
      watchUrl: '/watch/link-only-video',
      video: {
        id: 'video-1',
        title: 'Link-only cut',
        status: 'published',
        visibility: 'unlisted',
        publicVideoId: 'link-only-video',
      },
    });
    mocks.getSharingService.mockReturnValue({ updateOwnerPolicy });

    const response = await PUT(
      new NextRequest('https://vidak.example/api/videos/video-1/sharing', {
        method: 'PUT',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ audience: 'unlisted' }),
      }),
      { params: Promise.resolve({ videoId: 'video-1' }) },
    );

    expect(updateOwnerPolicy).toHaveBeenCalledWith('access-token', 'video-1', {
      audience: 'unlisted',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({
      audience: 'unlisted',
      watchUrl: '/watch/link-only-video',
      video: { visibility: 'unlisted' },
    });
  });
});
