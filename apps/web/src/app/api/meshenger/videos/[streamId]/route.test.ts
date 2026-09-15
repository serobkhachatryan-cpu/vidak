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
import {
  mintSharedVideoAuthorizationReceipt,
  sharedVideoAuthorizationReceiptCookieName,
} from '../../../../../server/shared-video-authorization-receipt';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };
const receiptSecret = 'shared-video-receipt-route-test-secret-0123456789';

describe('Meshenger video stream route', () => {
  beforeEach(() => {
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('passes a verified authorization receipt through the legacy player route', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/recording.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('segment', { status: 206 })));

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(resolveMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1', {
      hasRecentSharedAuthorizationReceipt: true,
    });
  });

  it('uses the canonical resolver for a receipt-bearing legacy playback request', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/canonical.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('canonical', { status: 206 })));

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('canonical');
    expect(resolveMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1', {
      hasRecentSharedAuthorizationReceipt: true,
    });
  });

  it('invalidates a rejected canonical URL and resolves it once more', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const invalidateMediaUrl = vi.fn();
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://media.example/rejected.mp4')
      .mockResolvedValueOnce('https://media.example/refreshed.mp4');
    mocks.createLibrary.mockReturnValue({
      invalidateMediaUrl,
      resolveMediaUrl,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('fresh', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('fresh');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).toHaveBeenNthCalledWith(1, viewer, 'stream-1', {
      hasRecentSharedAuthorizationReceipt: true,
    });
    expect(resolveMediaUrl).toHaveBeenNthCalledWith(2, viewer, 'stream-1', {
      hasRecentSharedAuthorizationReceipt: true,
    });
  });

  it('does not depend on a legacy receipt cache for a receipt-bearing request', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/recording.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('segment', { status: 206 })));

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(resolveMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1', {
      hasRecentSharedAuthorizationReceipt: true,
    });
  });

  it('keeps the legacy library call unchanged for a malformed authorization receipt', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/recording.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('segment', { status: 206 })));

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=not-a-valid-receipt`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(resolveMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
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
        headers: {
          authorization: 'Bearer access-token',
          range: 'bytes=0-6',
          'x-request-id': 'meshenger-playback-success-1',
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toBe('bytes 0-6/7');
    expect(response.headers.get('x-request-id')).toBe('meshenger-playback-success-1');
    await expect(response.text()).resolves.toBe('segment');
    expect(upstreamSignal?.aborted).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(invalidateMediaUrl).not.toHaveBeenCalled();
  });

  it('follows one validated source redirect server-side while preserving the byte range', async () => {
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/recording.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/recording.mp4?delivery-token=server-only' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('redirected media', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-15/16', 'Content-Type': 'video/mp4' },
        }),
      );
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: { authorization: 'Bearer access-token', range: 'bytes=0-15' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('location')).toBeNull();
    await expect(response.text()).resolves.toBe('redirected media');
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://media.example/recording.mp4',
      expect.objectContaining({ redirect: 'manual', headers: { Range: 'bytes=0-15' } }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example/recording.mp4?delivery-token=server-only',
      expect.objectContaining({ redirect: 'manual', headers: { Range: 'bytes=0-15' } }),
    );
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

  it('refreshes a stale 410 source URL once', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://media.example/gone.mp4')
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
        .mockResolvedValueOnce(new Response(null, { status: 410 }))
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

  it('refreshes once after a pre-header source network failure without exposing it', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://media.example/failed.mp4')
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
        .mockRejectedValueOnce(new Error('https://source.example/private.mp4?token=secret'))
        .mockResolvedValueOnce(new Response('recovered', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    const body = await response.text();
    expect(body).toBe('recovered');
    expect(body).not.toContain('source.example');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
  });

  it('refreshes once after a source-header timeout', async () => {
    vi.useFakeTimers();
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://media.example/timed-out.mp4')
      .mockResolvedValueOnce('https://media.example/refreshed.mp4');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl });
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
    let releaseFirstRequest!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let requestCount = 0;
    const fetcher = vi.fn((_: string, init?: RequestInit): Promise<Response> => {
      requestCount += 1;
      if (requestCount === 1) {
        releaseFirstRequest();
        return new Promise((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private source did not return headers')),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Response('recovered', { status: 206 }));
    });
    vi.stubGlobal('fetch', fetcher);

    const pending = GET(
      new NextRequest('https://vidak.example/api/meshenger/videos/stream-1', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );
    await firstRequestStarted;
    await vi.advanceTimersByTimeAsync(30_000);

    const response = await pending;
    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('recovered');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
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

  it('refreshes the renewed stream when its first upstream source is rejected', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new MeshengerVideoLibraryError('This video link has expired.', 'stream_expired', 401),
      )
      .mockResolvedValueOnce('https://media.example/renewed.mp4')
      .mockResolvedValueOnce('https://media.example/recovered.mp4');
    const renewPlayableStream = vi.fn().mockResolvedValue('renewed-stream');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl,
      renewPlayableStream,
      invalidateMediaUrl,
    });
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
      new NextRequest('https://vidak.example/api/meshenger/videos/expired-stream', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'expired-stream' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('recovered');
    expect(renewPlayableStream).toHaveBeenCalledWith(viewer, 'expired-stream');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'renewed-stream');
    expect(resolveMediaUrl).toHaveBeenLastCalledWith(viewer, 'renewed-stream');
  });
});
