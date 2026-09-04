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

import { GET } from './route';

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
  });
});
