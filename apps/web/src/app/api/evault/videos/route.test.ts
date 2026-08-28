import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
}));

vi.mock('../../../../server/evault-video-library', () => ({
  createEVaultVideoLibrary: mocks.createLibrary,
  EVaultVideoLibraryError: class EVaultVideoLibraryError extends Error {},
}));

vi.mock('../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { GET } from './route';

describe('eVault video library route', () => {
  beforeEach(() => {
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an account-private catalogue from the source-neutral service', async () => {
    const listWithContext = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'w3ds-file:@person.w3id/video-1',
          kind: 'file',
          title: 'Video from another app.mp4',
          accessScope: 'personal',
          streamIds: ['opaque-stream-id'],
        },
      ],
      conversations: [],
      messages: [],
    });
    mocks.createLibrary.mockReturnValue({ listWithContext });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@person.w3id' } }),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos', {
        headers: { authorization: 'Bearer access-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    await expect(response.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ title: 'Video from another app.mp4' })],
    });
    expect(listWithContext).toHaveBeenCalledWith({ eName: '@person.w3id' });
  });
});
