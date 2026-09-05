import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
}));

vi.mock('../../../../../../server/evault-video-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../server/evault-video-library')>()),
  createEVaultVideoLibrary: mocks.createLibrary,
}));

vi.mock('../../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };

describe('eVault video authorization warm-up route', () => {
  beforeEach(() => {
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('proves a viewer-bound source without loading media bytes', async () => {
    const authorizePlayableStream = vi.fn().mockResolvedValue(undefined);
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(authorizePlayableStream).toHaveBeenCalledWith(viewer, 'stream-1');
  });

  it('requires the same authenticated session as the media route', async () => {
    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize'),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_session' },
    });
    expect(mocks.createLibrary).not.toHaveBeenCalled();
  });
});
