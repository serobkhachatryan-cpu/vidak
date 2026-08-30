import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVaultVideoLibraryError } from '../../../../../../server/evault-video-library';

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

describe('eVault video preview route', () => {
  beforeEach(() => {
    mocks.getPreviewService.mockReset();
    mocks.getAuthService.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated preview access', async () => {
    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/preview'),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );
    expect(response.status).toBe(401);
  });

  it('rejects a grant that does not belong to the caller', async () => {
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: { eName: '@other.w3id' } }),
    });
    mocks.getPreviewService.mockReturnValue({
      openEVaultPreview: vi
        .fn()
        .mockRejectedValue(
          new EVaultVideoLibraryError(
            'This video is not available to this account.',
            'invalid_stream',
            403,
          ),
        ),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/preview', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(403);
  });
});
