import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
}));

vi.mock('../../../../../server/meshenger-video-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/meshenger-video-library')>()),
  createMeshengerVideoLibrary: mocks.createLibrary,
}));

vi.mock('../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { MeshengerVideoLibraryError } from '../../../../../server/meshenger-video-library';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };

describe('Meshenger video stream route', () => {
  beforeEach(() => {
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('clears the connection timeout once the upstream video response starts streaming', async () => {
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/recording.mp4');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });

    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        upstreamSignal = init?.signal ?? undefined;
        return new Response('segment', {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': '7',
            'Content-Range': 'bytes 0-6/7',
            'Accept-Ranges': 'bytes',
          },
        });
      }),
    );
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: { authorization: 'Bearer access-token', range: 'bytes=0-6' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toBe('bytes 0-6/7');
    await expect(response.text()).resolves.toBe('segment');
    expect(upstreamSignal?.aborted).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(invalidateMediaUrl).not.toHaveBeenCalled();
  });

  it('refreshes a cached source URL once when Meshenger rejects an expired media link', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://media.example/expired.mp4')
      .mockResolvedValueOnce('https://media.example/refreshed.mp4');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('recovered', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('recovered');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
  });

  it('renews an expired Meshenger stream before opening the upstream video', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new MeshengerVideoLibraryError('This video link has expired.', 'stream_expired', 401),
      )
      .mockResolvedValueOnce('https://media.example/renewed.mp4');
    const renewPlayableStream = vi.fn().mockResolvedValue('renewed-stream');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, renewPlayableStream });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('renewed', { status: 206 })));

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/expired-stream', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'expired-stream' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('renewed');
    expect(renewPlayableStream).toHaveBeenCalledWith(viewer, 'expired-stream');
    expect(resolveMediaUrl).toHaveBeenNthCalledWith(2, viewer, 'renewed-stream');
  });
});
