import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
  cacheInitialMediaRange: vi.fn(),
  getCachedMediaRange: vi.fn(),
  getPlaybackResolutionCache: vi.fn(),
  deletePlaybackResolutionCache: vi.fn(),
}));

vi.mock('../../../../../server/evault-video-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/evault-video-library')>()),
  createEVaultVideoLibrary: mocks.createLibrary,
}));

vi.mock('../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

vi.mock('../../../../../server/video-source-warmup', () => ({
  cacheInitialMediaRange: mocks.cacheInitialMediaRange,
  getCachedMediaRange: mocks.getCachedMediaRange,
}));

vi.mock('../../../../../server/playback-resolution-cache', () => ({
  getPlaybackResolutionCache: mocks.getPlaybackResolutionCache,
  deletePlaybackResolutionCache: mocks.deletePlaybackResolutionCache,
}));

import { EVaultVideoLibraryError } from '../../../../../server/evault-video-library';
import { setOperationalLogSinkForTests } from '../../../../../server/ops-observability';
import {
  mintSharedVideoAuthorizationReceipt,
  sharedVideoAuthorizationReceiptCookieName,
} from '../../../../../server/shared-video-authorization-receipt';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };
const receiptSecret = 'shared-video-receipt-route-test-secret-0123456789';
let operationalLogs: string[] = [];

describe('eVault video stream route', () => {
  beforeEach(() => {
    operationalLogs = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
    mocks.cacheInitialMediaRange.mockReset();
    mocks.cacheInitialMediaRange.mockImplementation(
      (_viewer: string, _url: string, body: ReadableStream<Uint8Array> | null) => body,
    );
    mocks.getCachedMediaRange.mockReset();
    mocks.getCachedMediaRange.mockReturnValue(undefined);
    mocks.getPlaybackResolutionCache.mockReset();
    mocks.getPlaybackResolutionCache.mockResolvedValue(undefined);
    mocks.deletePlaybackResolutionCache.mockReset();
    mocks.deletePlaybackResolutionCache.mockResolvedValue(false);
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
  });

  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes a verified viewer-and-stream-bound authorization receipt to the library', async () => {
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
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({
        priority: 'interactive',
        hasRecentSharedAuthorizationReceipt: true,
      }),
    );
  });

  it('uses a receipt-bound cross-replica resolution cache only after validating the stream', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const cachedUrl = 'https://media.example/cached-private.mp4?source-token=kept-server-side';
    const inspectBoundStream = vi.fn();
    const resolveMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, resolveMediaUrl });
    mocks.getPlaybackResolutionCache.mockResolvedValue(cachedUrl);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('cached bytes', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('cached bytes');
    expect(mocks.getPlaybackResolutionCache).toHaveBeenCalledWith({
      receipt,
      viewerEName: viewer.eName,
      streamId: 'stream-1',
    });
    expect(inspectBoundStream).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(operationalLogs)).not.toContain('cached-private');
    expect(JSON.stringify(operationalLogs)).not.toContain('source-token');
  });

  it('deletes a rejected receipt-bound URL and resolves once without reading it again', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const inspectBoundStream = vi.fn();
    const invalidateMediaUrl = vi.fn();
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/refreshed.mp4');
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream,
      invalidateMediaUrl,
      resolveMediaUrl,
    });
    mocks.getPlaybackResolutionCache.mockResolvedValue('https://media.example/rejected.mp4');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('fresh bytes', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('fresh bytes');
    expect(mocks.deletePlaybackResolutionCache).toHaveBeenCalledWith({
      receipt,
      viewerEName: viewer.eName,
      streamId: 'stream-1',
    });
    expect(mocks.getPlaybackResolutionCache).toHaveBeenCalledTimes(1);
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ hasRecentSharedAuthorizationReceipt: true }),
    );
  });

  it('keeps the normal library call for a malformed authorization receipt', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/recording.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('segment', { status: 206 })));

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=not-a-valid-receipt`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    const options = resolveMediaUrl.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options).toMatchObject({ priority: 'interactive', onTiming: expect.any(Function) });
    expect(options).not.toHaveProperty('hasRecentSharedAuthorizationReceipt');
  });

  it('refreshes an expired upstream media URL once and preserves the byte range', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://media.example/expired.mp4')
      .mockResolvedValueOnce('https://media.example/refreshed.mp4');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response('recovered', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-8/9', 'Content-Type': 'video/mp4' },
        }),
      );
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          range: 'bytes=0-8',
          'x-request-id': 'playback-success-1',
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-8/9');
    expect(response.headers.get('x-request-id')).toBe('playback-success-1');
    await expect(response.text()).resolves.toBe('recovered');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://media.example/refreshed.mp4',
      expect.objectContaining({ headers: { Range: 'bytes=0-8' } }),
    );
  });

  it('follows one signed CDN redirect on the server without exposing it to the player', async () => {
    const sourceUrl = 'https://media.example/private.mp4?source-token=secret';
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl: vi.fn().mockResolvedValue(sourceUrl),
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/delivery.mp4?cdn-token=private' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('redirected bytes', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-15/16',
            'Content-Type': 'video/mp4',
          },
        }),
      );
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: { authorization: 'Bearer access-token', range: 'bytes=0-15' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('redirected bytes');
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      sourceUrl,
      expect.objectContaining({ redirect: 'manual', headers: { Range: 'bytes=0-15' } }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example/delivery.mp4?cdn-token=private',
      expect.objectContaining({ redirect: 'manual', headers: { Range: 'bytes=0-15' } }),
    );
    expect(response.headers.get('location')).toBeNull();
  });

  it('refreshes a source once after an upstream 410', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://media.example/expired.mp4')
      .mockResolvedValueOnce('https://media.example/fresh.mp4');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 410 }))
        .mockResolvedValueOnce(new Response('fresh bytes', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('fresh bytes');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
  });

  it('serves an authorized opening range from the viewer-scoped RAM cache', async () => {
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/private.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.getCachedMediaRange.mockReturnValue({
      body: new Uint8Array([1, 2]),
      contentRange: 'bytes 0-1/9',
      contentType: 'video/mp4',
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          range: 'bytes=0-1',
          'x-request-id': 'playback-cache-timing-1',
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-1/9');
    expect(response.headers.get('content-length')).toBe('2');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2]);
    expect(mocks.getCachedMediaRange).toHaveBeenCalledWith(
      '@viewer.w3id',
      'https://media.example/private.mp4',
      'bytes=0-1',
    );
    expect(fetcher).not.toHaveBeenCalled();
    const timingEvents = operationalLogs
      .map((line) => JSON.parse(line))
      .filter((event) => event.code === 'media_response_ready_timing');
    expect(timingEvents).toHaveLength(1);
    expect(timingEvents[0]).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'playback-cache-timing-1',
      timing: {
        sessionValidationMs: expect.any(Number),
        sourceResolutionMs: expect.any(Number),
        responseReadyMs: expect.any(Number),
        initialRangeCacheHit: true,
        upstreamAttempts: 0,
      },
    });
    expect(timingEvents[0].timing.upstreamResponseHeadersMs).toBeUndefined();
  });

  it('starts upstream playback without waiting for a background cache fill', async () => {
    const sourceUrl = 'https://media.example/private.mp4?token=source-secret';
    const resolveMediaUrl = vi.fn(
      (_user, _streamId, options?: { onTiming?: (timing: Record<string, unknown>) => void }) => {
        options?.onTiming?.({
          mediaUrlCacheHit: false,
          sharedAccessVerificationMs: 5,
          eVaultResolutionMs: 11,
          directFileDereferenceMs: 7,
          platformTokenMs: 3,
          metadataReadMs: 0,
        });
        return Promise.resolve(sourceUrl);
      },
    );
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    const fetcher = vi.fn().mockResolvedValue(
      new Response('first bytes', {
        status: 206,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': '11',
          'Content-Range': 'bytes 0-10/100',
          'Content-Type': 'video/mp4',
        },
      }),
    );
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          range: 'bytes=0-10',
          'x-request-id': 'playback-upstream-timing-1',
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 0-10/100');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBeNull();
    await expect(response.text()).resolves.toBe('first bytes');
    expect(fetcher).toHaveBeenCalledWith(
      sourceUrl,
      expect.objectContaining({ headers: { Range: 'bytes=0-10' } }),
    );
    expect(mocks.cacheInitialMediaRange).toHaveBeenCalledWith(
      '@viewer.w3id',
      sourceUrl,
      expect.anything(),
      'bytes 0-10/100',
      'video/mp4',
    );
    const timingEvents = operationalLogs.map((line) => JSON.parse(line));
    const responseReadyTiming = timingEvents.find(
      (event) => event.code === 'media_response_ready_timing',
    );
    const firstByteTiming = timingEvents.find((event) => event.code === 'media_first_byte_timing');
    expect(responseReadyTiming).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'playback-upstream-timing-1',
      timing: {
        sessionValidationMs: expect.any(Number),
        sourceResolutionMs: expect.any(Number),
        mediaUrlCacheHit: false,
        sharedAccessVerificationMs: 5,
        eVaultResolutionMs: 11,
        directFileDereferenceMs: 7,
        platformTokenMs: 3,
        metadataReadMs: 0,
        upstreamResponseHeadersMs: expect.any(Number),
        responseReadyMs: expect.any(Number),
        initialRangeCacheHit: false,
        upstreamAttempts: 1,
      },
    });
    expect(firstByteTiming).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'playback-upstream-timing-1',
      timing: {
        upstreamFirstByteMs: expect.any(Number),
        requestFirstByteMs: expect.any(Number),
        sharedAccessVerificationMs: 5,
        eVaultResolutionMs: 11,
        directFileDereferenceMs: 7,
        platformTokenMs: 3,
        metadataReadMs: 0,
        initialRangeCacheHit: false,
        upstreamAttempts: 1,
      },
    });
    const timingLog = JSON.stringify(timingEvents);
    expect(timingLog).not.toContain('media.example');
    expect(timingLog).not.toContain('source-secret');
    expect(timingLog).not.toContain('stream-1');
    expect(timingLog).not.toContain('@viewer.w3id');
  });

  it('records timings only for the opening range, not every later seek', async () => {
    const sourceUrl = 'https://media.example/private.mp4';
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl: vi.fn().mockResolvedValue(sourceUrl),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('seek bytes', {
          status: 206,
          headers: {
            'Content-Range': 'bytes 65536-65545/100000',
            'Content-Type': 'video/mp4',
          },
        }),
      ),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: { authorization: 'Bearer access-token', range: 'bytes=65536-65545' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    await expect(response.text()).resolves.toBe('seek bytes');
    expect(operationalLogs).toEqual([]);
  });

  it('renews an expired playable stream before opening the upstream video', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new EVaultVideoLibraryError('This video link has expired.', 'stream_expired', 401),
      )
      .mockResolvedValueOnce('https://media.example/renewed.mp4');
    const renewPlayableStream = vi.fn().mockResolvedValue('renewed-stream');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, renewPlayableStream });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('renewed', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-6/7', 'Content-Type': 'video/mp4' },
        }),
      ),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/expired-stream', {
        headers: { authorization: 'Bearer access-token', range: 'bytes=0-6' },
      }),
      { params: Promise.resolve({ streamId: 'expired-stream' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('renewed');
    expect(renewPlayableStream).toHaveBeenCalledWith(viewer, 'expired-stream');
    expect(resolveMediaUrl).toHaveBeenNthCalledWith(
      2,
      viewer,
      'renewed-stream',
      expect.objectContaining({ priority: 'interactive', onTiming: expect.any(Function) }),
    );
  });

  it('refreshes the renewed stream when its first upstream source is rejected', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new EVaultVideoLibraryError('This video link has expired.', 'stream_expired', 401),
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
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('recovered', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/expired-stream', {
        headers: { authorization: 'Bearer access-token', 'x-request-id': 'playback-recovery-1' },
      }),
      { params: Promise.resolve({ streamId: 'expired-stream' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('recovered');
    expect(renewPlayableStream).toHaveBeenCalledWith(viewer, 'expired-stream');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'renewed-stream');
    expect(resolveMediaUrl).toHaveBeenLastCalledWith(
      viewer,
      'renewed-stream',
      expect.objectContaining({ priority: 'interactive', onTiming: expect.any(Function) }),
    );
    expect(operationalLogs).toContain(
      JSON.stringify({
        level: 'info',
        category: 'video_playback',
        correlationId: 'playback-recovery-1',
        code: 'stream_renewed_source_recovered',
      }),
    );
  });

  it('records fixed source-resolution failure timings without private identifiers', async () => {
    const privateSource = 'https://signed.example/private-source?token=source-secret';
    const resolveMediaUrl = vi.fn(
      (_user, _streamId, options?: { onTiming?: (timing: Record<string, unknown>) => void }) => {
        options?.onTiming?.({
          mediaUrlCacheHit: false,
          sharedAccessVerificationMs: 17,
          eVaultResolutionMs: 29,
          directFileDereferenceMs: 31,
          platformTokenMs: 37,
          metadataReadMs: 41,
        });
        return Promise.reject(new Error(privateSource));
      },
    );
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/private-stream', {
        headers: {
          authorization: 'Bearer access-token',
          'x-request-id': 'playback-failure-timing-1',
        },
      }),
      { params: Promise.resolve({ streamId: 'private-stream' }) },
    );

    expect(response.status).toBe(500);
    const events = operationalLogs.map((line) => JSON.parse(line));
    const timing = events.find((event) => event.code === 'media_source_resolution_failed_timing');
    expect(timing).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'playback-failure-timing-1',
      timing: {
        sessionValidationMs: expect.any(Number),
        sourceResolutionMs: expect.any(Number),
        mediaUrlCacheHit: false,
        sharedAccessVerificationMs: 17,
        eVaultResolutionMs: 29,
        directFileDereferenceMs: 31,
        platformTokenMs: 37,
        metadataReadMs: 41,
        requestFailedMs: expect.any(Number),
      },
    });
    expect(Object.keys(timing.timing).sort()).toEqual([
      'directFileDereferenceMs',
      'eVaultResolutionMs',
      'mediaUrlCacheHit',
      'metadataReadMs',
      'platformTokenMs',
      'requestFailedMs',
      'sessionValidationMs',
      'sharedAccessVerificationMs',
      'sourceResolutionMs',
    ]);
    expect(events.some((event) => event.code === 'media_response_ready_timing')).toBe(false);
    const log = JSON.stringify(events);
    expect(log).not.toContain('private-stream');
    expect(log).not.toContain('signed.example');
    expect(log).not.toContain('source-secret');
    expect(log).not.toContain('@viewer.w3id');
  });

  it('reports an opaque playback failure without source details', async () => {
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl: vi
        .fn()
        .mockRejectedValue(new Error('https://signed.example/private-source?token=secret')),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/private-stream', {
        headers: { authorization: 'Bearer access-token', 'x-request-id': 'playback-failure-1' },
      }),
      { params: Promise.resolve({ streamId: 'private-stream' }) },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe('playback-failure-1');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const events = operationalLogs.map((line) => JSON.parse(line));
    const failure = events.find((event) => event.level === 'error');
    expect(failure).toMatchObject({
      category: 'video_playback',
      code: 'internal_error',
    });
    const log = JSON.stringify(events);
    expect(log).not.toContain('private-stream');
    expect(log).not.toContain('signed.example');
    expect(log).not.toContain('secret');
  });
});
