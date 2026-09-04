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

describe('shared video metadata route', () => {
  beforeEach(() => {
    mocks.getSharingService.mockReset();
  });

  it('never lets a browser cache a shared-video authorization result', async () => {
    const unauthenticated = await GET(
      new NextRequest('https://vidak.example/api/videos/shared/share_token'),
      { params: Promise.resolve({ shareToken: 'share_token' }) },
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('cache-control')).toBe('private, no-store');

    mocks.getSharingService.mockReturnValue({
      getSharedVideo: vi.fn().mockResolvedValue({
        id: 'video-1',
        title: 'Private cut',
        thumbnailUrl: '',
        mediaContentUrl: '',
      }),
    });
    const authorized = await GET(
      new NextRequest('https://vidak.example/api/videos/shared/share_token', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ shareToken: 'share_token' }) },
    );
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('cache-control')).toBe('private, no-store');
  });
});
