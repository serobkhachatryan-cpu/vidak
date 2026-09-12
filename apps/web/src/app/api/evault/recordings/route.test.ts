import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
}));

vi.mock('../../../../server/evault-video-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/evault-video-library')>()),
  createEVaultVideoLibrary: mocks.createLibrary,
}));

vi.mock('../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { resetRecordingConcatTicketsForTests } from '../../../../server/recording-concat-ticket';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };

describe('continuous recording compatibility route', () => {
  beforeEach(async () => {
    await resetRecordingConcatTicketsForTests();
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
  });

  it('redirects an old player after validating only the first source', async () => {
    const inspectBoundStream = vi.fn();
    const resolveMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, resolveMediaUrl });

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings?stream=source-1&stream=source-2',
        { headers: { authorization: 'Bearer access-token' } },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toMatch(
      /^https:\/\/vidak\.example\/api\/evault\/recordings\/[A-Za-z0-9_-]{43}$/,
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(inspectBoundStream).toHaveBeenNthCalledWith(1, viewer, 'source-1');
    expect(inspectBoundStream).toHaveBeenCalledTimes(1);
    expect(resolveMediaUrl).not.toHaveBeenCalled();
  });

  it('accepts an hour-long segment list rather than recreating the old 24-file cap', async () => {
    const inspectBoundStream = vi.fn();
    mocks.createLibrary.mockReturnValue({ inspectBoundStream });
    const query = new URLSearchParams();
    for (let index = 0; index < 80; index += 1) query.append('stream', `source-${index}`);

    const response = await GET(
      new NextRequest(`https://vidak.example/api/evault/recordings?${query}`, {
        headers: { authorization: 'Bearer access-token' },
      }),
    );

    expect(response.status).toBe(307);
    expect(inspectBoundStream).toHaveBeenCalledTimes(1);
  });

  it('rejects a clip list that cannot be one recording', async () => {
    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/recordings?stream=source-1', {
        headers: { authorization: 'Bearer access-token' },
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createLibrary).not.toHaveBeenCalled();
  });
});
