import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  fetch: vi.fn(),
  readSegment: vi.fn(),
  replaceSegment: vi.fn(),
  getPlaybackResolutionCache: vi.fn(),
  deletePlaybackResolutionCache: vi.fn(),
}));

vi.mock('../../../../../../../server/evault-video-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../../server/evault-video-library')>()),
  createEVaultVideoLibrary: mocks.createLibrary,
}));

vi.mock('../../../../../../../server/recording-concat-ticket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../../server/recording-concat-ticket')>()),
  readRecordingConcatSegment: mocks.readSegment,
  replaceRecordingConcatSegment: mocks.replaceSegment,
}));

vi.mock('../../../../../../../server/playback-resolution-cache', () => ({
  getPlaybackResolutionCache: mocks.getPlaybackResolutionCache,
  deletePlaybackResolutionCache: mocks.deletePlaybackResolutionCache,
}));

import { EVaultVideoLibraryError } from '../../../../../../../server/evault-video-library';
import { setOperationalLogSinkForTests } from '../../../../../../../server/ops-observability';
import { mintSharedVideoAuthorizationReceipt } from '../../../../../../../server/shared-video-authorization-receipt';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };
let operationalLogs: string[] = [];

describe('lazy recording segment route', () => {
  beforeEach(() => {
    operationalLogs = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    mocks.createLibrary.mockReset();
    mocks.fetch.mockReset();
    mocks.readSegment.mockReset();
    mocks.replaceSegment.mockReset();
    mocks.getPlaybackResolutionCache.mockReset();
    mocks.getPlaybackResolutionCache.mockResolvedValue(undefined);
    mocks.deletePlaybackResolutionCache.mockReset();
    mocks.deletePlaybackResolutionCache.mockResolvedValue(false);
    mocks.readSegment.mockReturnValue({
      viewer,
      streamId: 'source-7',
      correlationId: 'recording-correlation-7',
    });
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('resolves and proxies exactly the requested segment, preserving Range', async () => {
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://source.example/private.mp4');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl });
    mocks.fetch.mockResolvedValue(
      new Response('media-bytes', {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-length': '11',
          'content-range': 'bytes 0-10/100',
          'content-type': 'video/mp4',
        },
      }),
    );

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/7?key=internal-secret',
        { headers: { range: 'bytes=0-' } },
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '7' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-10/100');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(mocks.readSegment).toHaveBeenCalledWith('opaque-ticket', 'internal-secret', '7');
    expect(resolveMediaUrl).toHaveBeenCalledWith(viewer, 'source-7');
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://source.example/private.mp4',
      expect.objectContaining({
        cache: 'no-store',
        redirect: 'manual',
        headers: { Range: 'bytes=0-' },
      }),
    );
    expect(invalidateMediaUrl).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe('media-bytes');
    // Continuous recordings can contain hundreds of sources. Only segment
    // zero is a cold-start signal, so later ffmpeg reads do not amplify logs.
    expect(operationalLogs).toEqual([]);
  });

  it('preauthorizes exactly the next segment after the current source starts without delaying it', async () => {
    let finishWarmup: (() => void) | undefined;
    const pendingWarmup = new Promise<void>((resolve) => {
      finishWarmup = resolve;
    });
    mocks.readSegment.mockImplementation((_ticket: string, _key: string | null, index: string) => {
      if (index === '0') {
        return { viewer, streamId: 'source-7', correlationId: 'recording-correlation-7' };
      }
      if (index === '1') {
        return { viewer, streamId: 'source-8', correlationId: 'recording-correlation-7' };
      }
      throw new Error('The ticket has no more sources.');
    });
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://source.example/private.mp4');
    const authorizePlayableStream = vi.fn().mockReturnValue(pendingWarmup);
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl,
      authorizePlayableStream,
      invalidateMediaUrl: vi.fn(),
    });
    mocks.fetch.mockResolvedValue(new Response('media-bytes', { status: 206 }));

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    // The current response is ready even while the optional next authorization
    // remains pending; no next media request is opened by this warmup.
    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('media-bytes');
    await vi.waitFor(() => {
      expect(authorizePlayableStream).toHaveBeenCalledWith(
        viewer,
        'source-8',
        expect.objectContaining({ priority: 'warmup', signal: expect.any(AbortSignal) }),
      );
    });
    expect(mocks.readSegment).toHaveBeenCalledWith('opaque-ticket', 'internal-secret', '0');
    expect(mocks.readSegment).toHaveBeenCalledWith('opaque-ticket', 'internal-secret', '1');
    expect(mocks.readSegment).not.toHaveBeenCalledWith('opaque-ticket', 'internal-secret', '2');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    finishWarmup?.();
    await Promise.resolve();
  });

  it('keeps the current segment playable when next-segment warmup fails', async () => {
    mocks.readSegment.mockImplementation((_ticket: string, _key: string | null, index: string) => {
      if (index === '0') {
        return { viewer, streamId: 'source-7', correlationId: 'recording-correlation-7' };
      }
      if (index === '1') {
        return { viewer, streamId: 'source-8', correlationId: 'recording-correlation-7' };
      }
      throw new Error('The ticket has no more sources.');
    });
    const authorizePlayableStream = vi
      .fn()
      .mockRejectedValue(new Error('https://source.example/next.mp4?private-token=must-not-leak'));
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl: vi.fn().mockResolvedValue('https://source.example/current.mp4'),
      authorizePlayableStream,
      invalidateMediaUrl: vi.fn(),
    });
    mocks.fetch.mockResolvedValue(new Response('current bytes', { status: 206 }));

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('current bytes');
    await vi.waitFor(() => expect(authorizePlayableStream).toHaveBeenCalledTimes(1));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(JSON.stringify(operationalLogs)).not.toContain('private-token');
  });

  it('records initial-segment source, upstream-header, and first-byte timings without source data', async () => {
    const mediaUrl = 'https://source.example/private.mp4?token=source-secret';
    const resolveMediaUrl = vi.fn(
      (
        _user: unknown,
        _streamId: unknown,
        options?: { onTiming?: (timing: Record<string, unknown>) => void },
      ) => {
        options?.onTiming?.({
          mediaUrlCacheHit: false,
          sharedAccessVerificationMs: 5,
          eVaultResolutionMs: 11,
          directFileDereferenceMs: 7,
          platformTokenMs: 3,
          metadataReadMs: 0,
        });
        return Promise.resolve(mediaUrl);
      },
    );
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl: vi.fn() });
    mocks.fetch.mockResolvedValue(
      new Response('media-bytes', {
        status: 206,
        headers: {
          'content-range': 'bytes 0-10/100',
          'content-type': 'video/mp4',
        },
      }),
    );

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
        { headers: { range: 'bytes=0-' } },
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('media-bytes');
    const events = operationalLogs.map((line) => JSON.parse(line));
    const responseReady = events.find(
      (event) => event.code === 'recording_segment_response_ready_timing',
    );
    const firstByte = events.find((event) => event.code === 'recording_segment_first_byte_timing');
    expect(responseReady).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'recording-correlation-7',
      timing: {
        sourceResolutionMs: expect.any(Number),
        mediaUrlCacheHit: false,
        sharedAccessVerificationMs: 5,
        eVaultResolutionMs: 11,
        directFileDereferenceMs: 7,
        platformTokenMs: 3,
        metadataReadMs: 0,
        upstreamResponseHeadersMs: expect.any(Number),
        segmentResponseReadyMs: expect.any(Number),
        upstreamAttempts: 1,
      },
    });
    expect(firstByte).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'recording-correlation-7',
      timing: {
        upstreamFirstByteMs: expect.any(Number),
        segmentRequestFirstByteMs: expect.any(Number),
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('source.example');
    expect(serialized).not.toContain('source-secret');
    expect(serialized).not.toContain('source-7');
    expect(serialized).not.toContain('@viewer.w3id');
    expect(serialized).not.toContain('opaque-ticket');
    expect(serialized).not.toContain('internal-secret');
  });

  it('reuses a cryptographically verified source-zero receipt without exposing it to ffmpeg', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', '12345678901234567890123456789012');
    const initialAuthorizationReceipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'source-7',
    });
    mocks.readSegment.mockReturnValue({
      viewer,
      streamId: 'source-7',
      correlationId: 'recording-correlation-7',
      initialAuthorizationReceipt,
    });
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://source.example/private.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl: vi.fn() });
    mocks.fetch.mockResolvedValue(new Response('media-bytes', { status: 206 }));

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(206);
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'source-7',
      expect.objectContaining({
        hasRecentSharedAuthorizationReceipt: true,
        onTiming: expect.any(Function),
      }),
    );
    expect(JSON.stringify(mocks.fetch.mock.calls)).not.toContain(initialAuthorizationReceipt);
  });

  it('uses a receipt-bound cache for source zero only after current playable-access validation', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', '12345678901234567890123456789012');
    const initialAuthorizationReceipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'source-7',
    });
    mocks.readSegment.mockReturnValue({
      viewer,
      streamId: 'source-7',
      correlationId: 'recording-correlation-7',
      initialAuthorizationReceipt,
    });
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/source-7' });
    const resolveMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ inspectPlayableStream, resolveMediaUrl });
    mocks.getPlaybackResolutionCache.mockResolvedValue(
      'https://source.example/cached.mp4?source-token=kept-server-side',
    );
    mocks.fetch.mockResolvedValue(new Response('cached bytes', { status: 206 }));

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('cached bytes');
    expect(mocks.getPlaybackResolutionCache).toHaveBeenCalledWith({
      receipt: initialAuthorizationReceipt,
      viewerEName: viewer.eName,
      streamId: 'source-7',
    });
    expect(inspectPlayableStream).toHaveBeenCalledWith(
      viewer,
      'source-7',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(resolveMediaUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.fetch.mock.calls)).not.toContain(initialAuthorizationReceipt);
  });

  it('does not proxy a cached source-zero URL after the viewer loses playable access', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', '12345678901234567890123456789012');
    const initialAuthorizationReceipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'source-7',
    });
    mocks.readSegment.mockReturnValue({
      viewer,
      streamId: 'source-7',
      correlationId: 'recording-correlation-7',
      initialAuthorizationReceipt,
    });
    const inspectPlayableStream = vi
      .fn()
      .mockRejectedValue(
        new EVaultVideoLibraryError(
          'The viewer no longer has access.',
          'authorization_denied',
          403,
        ),
      );
    const resolveMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ inspectPlayableStream, resolveMediaUrl });
    mocks.getPlaybackResolutionCache.mockResolvedValue(
      'https://source.example/cached.mp4?source-token=kept-server-side',
    );

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(403);
    expect(inspectPlayableStream).toHaveBeenCalledWith(
      viewer,
      'source-7',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(resolveMediaUrl).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('deletes a rejected source-zero cache entry and retries normal resolution once', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', '12345678901234567890123456789012');
    const initialAuthorizationReceipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'source-7',
    });
    mocks.readSegment.mockReturnValue({
      viewer,
      streamId: 'source-7',
      correlationId: 'recording-correlation-7',
      initialAuthorizationReceipt,
    });
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/source-7' });
    const invalidateMediaUrl = vi.fn();
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://source.example/fresh.mp4');
    mocks.createLibrary.mockReturnValue({
      inspectPlayableStream,
      invalidateMediaUrl,
      resolveMediaUrl,
    });
    mocks.getPlaybackResolutionCache.mockResolvedValue('https://source.example/rejected.mp4');
    mocks.fetch
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response('fresh bytes', { status: 206 }));

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('fresh bytes');
    expect(mocks.deletePlaybackResolutionCache).toHaveBeenCalledWith({
      receipt: initialAuthorizationReceipt,
      viewerEName: viewer.eName,
      streamId: 'source-7',
    });
    expect(mocks.getPlaybackResolutionCache).toHaveBeenCalledTimes(1);
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'source-7');
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'source-7',
      expect.objectContaining({ hasRecentSharedAuthorizationReceipt: true }),
    );
  });

  it('records a separate initial-segment source-resolution failure timing', async () => {
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl: vi.fn().mockRejectedValue(new Error('source-secret must not be logged')),
    });

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(500);
    const events = operationalLogs.map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'recording-correlation-7',
      code: 'recording_segment_source_resolution_failed_timing',
      timing: {
        sourceResolutionMs: expect.any(Number),
        segmentRequestFailedMs: expect.any(Number),
      },
    });
    expect(JSON.stringify(events)).not.toContain('source-secret');
  });

  it('follows a validated source redirect server-side while preserving the segment range', async () => {
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://source.example/private.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl: vi.fn() });
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/segment.mp4?delivery-token=server-only' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('media-bytes', {
          status: 206,
          headers: { 'content-range': 'bytes 0-10/100', 'content-type': 'video/mp4' },
        }),
      );

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
        { headers: { range: 'bytes=0-10' } },
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('location')).toBeNull();
    await expect(response.text()).resolves.toBe('media-bytes');
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      1,
      'https://source.example/private.mp4',
      expect.objectContaining({ redirect: 'manual', headers: { Range: 'bytes=0-10' } }),
    );
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example/segment.mp4?delivery-token=server-only',
      expect.objectContaining({ redirect: 'manual', headers: { Range: 'bytes=0-10' } }),
    );
    const events = operationalLogs.map((line) => JSON.parse(line));
    const responseReady = events.find(
      (event) => event.code === 'recording_segment_response_ready_timing',
    );
    expect(responseReady).toMatchObject({ timing: { upstreamAttempts: 2 } });
  });

  it('invalidates and resolves only the current segment once when its source is gone', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://source.example/expired.mp4')
      .mockResolvedValueOnce('https://source.example/fresh.mp4');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl });
    mocks.fetch
      .mockResolvedValueOnce(new Response('gone', { status: 410 }))
      .mockResolvedValueOnce(new Response('media-bytes', { status: 200 }));

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
      ),
      { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
    );

    expect(response.status).toBe(200);
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'source-7');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      'https://source.example/fresh.mp4',
      expect.any(Object),
    );
  });

  it('uses its timeout only while waiting for source response headers', async () => {
    vi.useFakeTimers();
    let sourceSignal: AbortSignal | undefined;
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://source.example/slow.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl: vi.fn() });
    mocks.fetch.mockImplementation(async (_url, init?: RequestInit) => {
      sourceSignal = init?.signal ?? undefined;
      return new Response('media-bytes', { status: 200 });
    });

    try {
      const response = await GET(
        new NextRequest(
          'https://vidak.example/api/evault/recordings/opaque-ticket/segments/0?key=internal-secret',
        ),
        { params: Promise.resolve({ ticket: 'opaque-ticket', index: '0' }) },
      );

      expect(response.status).toBe(200);
      expect(sourceSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(sourceSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
