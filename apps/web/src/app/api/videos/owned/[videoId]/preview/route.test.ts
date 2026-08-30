import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoPreviewError } from '../../../../../../server/video-preview';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getPreviewService: vi.fn(),
  getAuthService: vi.fn(),
}));

vi.mock('../../../../../../server/video-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../server/video-preview')>()),
  getVideoPreviewService: mocks.getPreviewService,
}));

vi.mock('../../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { GET } from './route';

describe('owned video preview route', () => {
  beforeEach(() => {
    mocks.getPreviewService.mockReset();
    mocks.getAuthService.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated preview access', async () => {
    const response = await GET(
      new NextRequest('https://vidak.example/api/videos/owned/v1/preview'),
      {
        params: Promise.resolve({ videoId: 'v1' }),
      },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  it('rejects another account’s preview', async () => {
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { id: 'user-b' } }),
    });
    mocks.getPreviewService.mockReturnValue({
      openOwnedPreview: vi
        .fn()
        .mockRejectedValue(new VideoPreviewError('Video was not found.', 'not_found', 404)),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/videos/owned/v1/preview', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ videoId: 'v1' }) },
    );

    expect(response.status).toBe(404);
  });

  it('serves a private jpeg only after auth', async () => {
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { id: 'user-a' } }),
    });
    mocks.getPreviewService.mockReturnValue({
      openOwnedPreview: vi.fn().mockResolvedValue({
        status: 'ready',
        body: new Uint8Array([1, 2, 3]),
        contentType: 'image/jpeg',
      }),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/videos/owned/v1/preview', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ videoId: 'v1' }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });
});
