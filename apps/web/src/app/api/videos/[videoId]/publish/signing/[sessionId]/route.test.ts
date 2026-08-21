import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ getSigningService: vi.fn() }));

vi.mock('../../../../../../../server/w3ds-video-publication-signing', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../../../../server/w3ds-video-publication-signing')
  >()),
  getW3dsVideoPublicationSigningService: mocks.getSigningService,
}));

import { GET } from './route';

describe('signed video publication status route', () => {
  beforeEach(() => {
    mocks.getSigningService.mockReset();
  });

  it('requires an authenticated owner before reading signing status', async () => {
    const response = await GET(
      new NextRequest('https://vidak.example/api/videos/video-1/publish/signing/session-1'),
      { params: Promise.resolve({ videoId: 'video-1', sessionId: 'session-1' }) },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.getSigningService).not.toHaveBeenCalled();
  });

  it("returns only the authenticated owner's offer state", async () => {
    const getOfferStatus = vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      videoId: 'video-1',
      status: 'completed',
      expiresAt: '2026-08-21T12:00:00.000Z',
      video: { id: 'video-1', status: 'published', publicVideoId: 'pub_video-1' },
    });
    mocks.getSigningService.mockReturnValue({ getOfferStatus });

    const response = await GET(
      new NextRequest('https://vidak.example/api/videos/video-1/publish/signing/session-1', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ videoId: 'video-1', sessionId: 'session-1' }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      sessionId: 'session-1',
      status: 'completed',
      video: { publicVideoId: 'pub_video-1' },
    });
    expect(getOfferStatus).toHaveBeenCalledWith({
      accessToken: 'access-token',
      videoId: 'video-1',
      sessionId: 'session-1',
    });
  });
});
