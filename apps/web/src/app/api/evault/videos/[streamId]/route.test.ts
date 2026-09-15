import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
  cacheInitialMediaRange: vi.fn(),
  getCachedMediaRange: vi.fn(),
  getPlaybackResolutionCache: vi.fn(),
  claimPlaybackSourceRefresh: vi.fn(),
  failPlaybackSourceRefresh: vi.fn(),
  publishPlaybackSourceRefresh: vi.fn(),
  readPlaybackSourceRefresh: vi.fn(),
  releasePlaybackSourceRefresh: vi.fn(),
  recordConfirmedSharedPlaybackDenial: vi.fn(),
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
}));

vi.mock('../../../../../server/playback-source-refresh', () => ({
  claimPlaybackSourceRefresh: mocks.claimPlaybackSourceRefresh,
  failPlaybackSourceRefresh: mocks.failPlaybackSourceRefresh,
  publishPlaybackSourceRefresh: mocks.publishPlaybackSourceRefresh,
  readPlaybackSourceRefresh: mocks.readPlaybackSourceRefresh,
  releasePlaybackSourceRefresh: mocks.releasePlaybackSourceRefresh,
}));

vi.mock('../../../../../server/video-space/shared-playback-card-quarantine', () => ({
  recordConfirmedSharedPlaybackDenial: mocks.recordConfirmedSharedPlaybackDenial,
}));

import { EVaultVideoLibraryError } from '../../../../../server/evault-video-library';
import { setOperationalLogSinkForTests } from '../../../../../server/ops-observability';
import {
  mintSharedVideoAuthorizationReceipt,
  sharedVideoAuthorizationReceiptCookieName,
  sharedVideoStreamAuthorizationReceiptCookieName,
} from '../../../../../server/shared-video-authorization-receipt';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };
const receiptSecret = 'shared-video-receipt-route-test-secret-0123456789';
let operationalLogs: string[] = [];
let nextServerOnlyRefreshReceipt = 0;

function createNoReceiptRecoveryMocks() {
  // The server-only receipt is consumed by the same bounded reader as the
  // browser receipt, which fingerprints it with the deployment secret.
  vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
  const proof = Object.freeze({});
  const readReceipt = `server-only-refresh-receipt-${++nextServerOnlyRefreshReceipt}`;
  return {
    proof,
    readReceipt,
    proveCurrentPlayableStreamForSourceRefresh: vi.fn().mockResolvedValue(proof),
    playbackSourceRefreshReadReceiptAfterCurrentProof: vi.fn().mockReturnValue(readReceipt),
    adoptReadyPlaybackSourceAfterCurrentProof: vi.fn().mockReturnValue(true),
  };
}

function explicitlyExpiringMediaUrl(name: string): string {
  return `https://media.example/${name}.mp4?expires=${Math.floor((Date.now() + 120_000) / 1000)}&signature=test-source`;
}

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
    mocks.claimPlaybackSourceRefresh.mockReset();
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({
      kind: 'acquired',
      lease: { epoch: 1, token: 'test-lease', expiresAt: Date.now() + 30_000 },
    });
    mocks.failPlaybackSourceRefresh.mockReset();
    mocks.failPlaybackSourceRefresh.mockResolvedValue(true);
    mocks.releasePlaybackSourceRefresh.mockReset();
    mocks.releasePlaybackSourceRefresh.mockResolvedValue(true);
    mocks.publishPlaybackSourceRefresh.mockReset();
    mocks.publishPlaybackSourceRefresh.mockResolvedValue(true);
    mocks.readPlaybackSourceRefresh.mockReset();
    mocks.readPlaybackSourceRefresh.mockResolvedValue({ kind: 'absent' });
    mocks.recordConfirmedSharedPlaybackDenial.mockReset();
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
    expect(resolveMediaUrl).not.toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ forceSourceRefresh: true }),
    );
  });

  it('resolves a fresh authorized source when the initial durable fence lookup fails', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'initial-store-fallback',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValue('https://media.example/initial-store-fallback.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.readPlaybackSourceRefresh.mockRejectedValue(new Error('temporary Postgres outage'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('fresh bytes', { status: 206 }))),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/initial-store-fallback', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'initial-store-fallback' }) },
    );

    expect(response.status).toBe(206);
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'initial-store-fallback',
      expect.objectContaining({ hasRecentSharedAuthorizationReceipt: true }),
    );
    expect(operationalLogs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        category: 'video_playback',
        code: 'source_refresh_store_unavailable_initial',
      }),
    );
  });

  it('keeps video A warm after video B overwrites the legacy receipt cookie', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receiptForA = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-a',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const receiptForB = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-b',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi.fn().mockResolvedValue('https://media.example/video-a.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('video A', { status: 206 })));

    // This is the browser cookie state after warming A and then B: the
    // compatibility /api cookie now holds B, while A's narrower player path
    // still sends A's receipt. The player must select the scoped A receipt.
    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-a', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: [
            `${sharedVideoStreamAuthorizationReceiptCookieName}=${receiptForA}`,
            `${sharedVideoAuthorizationReceiptCookieName}=${receiptForB}`,
          ].join('; '),
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-a' }) },
    );

    expect(response.status).toBe(206);
    expect(mocks.readPlaybackSourceRefresh).toHaveBeenCalledWith({
      receipt: receiptForA,
      viewerEName: viewer.eName,
      streamId: 'stream-a',
    });
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'stream-a',
      expect.objectContaining({ hasRecentSharedAuthorizationReceipt: true }),
    );
  });

  it('uses a durable ready handoff before local source work', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/durable' });
    const resolveMediaUrl = vi.fn();
    const adoptReadyPlaybackSourceAfterAuthorizationReceipt = vi.fn().mockReturnValue(true);
    mocks.createLibrary.mockReturnValue({
      inspectPlayableStream,
      resolveMediaUrl,
      adoptReadyPlaybackSourceAfterAuthorizationReceipt,
    });
    mocks.readPlaybackSourceRefresh.mockResolvedValue({
      kind: 'ready',
      epoch: 4,
      mediaUrl: 'https://media.example/fresh-durable.mp4?source-token=server-only',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('fresh bytes', { status: 206 })));

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
    expect(inspectPlayableStream).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(resolveMediaUrl).not.toHaveBeenCalled();
    expect(mocks.readPlaybackSourceRefresh).toHaveBeenCalledWith({
      receipt,
      viewerEName: viewer.eName,
      streamId: 'stream-1',
    });
    expect(mocks.getPlaybackResolutionCache).not.toHaveBeenCalled();
    expect(adoptReadyPlaybackSourceAfterAuthorizationReceipt).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      receipt,
      'https://media.example/fresh-durable.mp4?source-token=server-only',
    );
  });

  it('uses the canonical eVault resolver instead of the retired receipt URL cache', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const cachedUrl = 'https://media.example/cached-private.mp4?source-token=kept-server-side';
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/cached' });
    const resolveMediaUrl = vi.fn().mockResolvedValue(cachedUrl);
    mocks.createLibrary.mockReturnValue({ inspectPlayableStream, resolveMediaUrl });
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
    expect(mocks.getPlaybackResolutionCache).not.toHaveBeenCalled();
    expect(inspectPlayableStream).not.toHaveBeenCalled();
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ hasRecentSharedAuthorizationReceipt: true }),
    );
    expect(JSON.stringify(operationalLogs)).not.toContain('cached-private');
    expect(JSON.stringify(operationalLogs)).not.toContain('source-token');
  });

  it('fences the legacy cache while another replica is resolving a source', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.readPlaybackSourceRefresh.mockResolvedValue({ kind: 'resolving', epoch: 9 });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.getPlaybackResolutionCache).not.toHaveBeenCalled();
    expect(resolveMediaUrl).not.toHaveBeenCalled();
  });

  it('keeps an explicit unavailable durable state fenced on an initial source request', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'explicit-durable-fence',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.readPlaybackSourceRefresh.mockResolvedValue({ kind: 'unavailable' });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/explicit-durable-fence', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId: 'explicit-durable-fence' }) },
    );

    expect(response.status).toBe(503);
    expect(resolveMediaUrl).not.toHaveBeenCalled();
  });

  it('takes over an expired recovery lease instead of falling back to an old URL', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const inspectBoundStream = vi.fn();
    const resolveMediaUrl = vi.fn().mockResolvedValue(explicitlyExpiringMediaUrl('recovered'));
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, resolveMediaUrl });
    mocks.readPlaybackSourceRefresh.mockResolvedValue({ kind: 'retryable', epoch: 8 });
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({
      kind: 'acquired',
      lease: { epoch: 9, token: 'new-owner', expiresAt: Date.now() + 30_000 },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('recovered', { status: 206 })));

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
    expect(inspectBoundStream).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
    });
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ forceSourceRefresh: true }),
    );
    expect(mocks.publishPlaybackSourceRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ lease: expect.objectContaining({ epoch: 9 }) }),
    );
  });

  it('recovers a rejected legacy source through a durable claim, not a blind cache delete', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/recovery' });
    const invalidateMediaUrl = vi.fn();
    const resolveMediaUrl = vi.fn().mockResolvedValue(explicitlyExpiringMediaUrl('refreshed'));
    mocks.createLibrary.mockReturnValue({
      inspectPlayableStream,
      invalidateMediaUrl,
      resolveMediaUrl,
    });
    mocks.getPlaybackResolutionCache.mockResolvedValue('https://media.example/rejected.mp4');
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({
      kind: 'acquired',
      lease: { epoch: 2, token: 'recovery-owner', expiresAt: Date.now() + 30_000 },
    });
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
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.publishPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
    expect(resolveMediaUrl).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ forceSourceRefresh: true }),
    );
  });

  it('serves resident receipt-local bytes without waiting for a stalled durable read', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'fast-range-stream',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const sourceUrl = 'https://media.example/fast-range.mp4';
    const resolveMediaUrl = vi.fn().mockResolvedValue(sourceUrl);
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/fast' });
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, inspectPlayableStream });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockReturnValue(new Promise(() => undefined));
    mocks.getCachedMediaRange.mockReturnValueOnce(undefined).mockReturnValueOnce({
      body: new Uint8Array([7, 8]),
      contentRange: 'bytes 0-1/9',
      contentType: 'video/mp4',
    });
    const fetcher = vi.fn(() => Promise.resolve(new Response('first range', { status: 206 })));
    vi.stubGlobal('fetch', fetcher);
    const request = () =>
      new NextRequest('https://vidak.example/api/evault/videos/fast-range-stream', {
        headers: {
          authorization: 'Bearer access-token',
          range: 'bytes=0-1',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      });

    const first = await GET(request(), {
      params: Promise.resolve({ streamId: 'fast-range-stream' }),
    });
    expect(first.status).toBe(206);
    const second = await resolvesWithinTestDeadline(
      GET(request(), { params: Promise.resolve({ streamId: 'fast-range-stream' }) }),
    );

    expect(second.status).toBe(206);
    expect([...new Uint8Array(await second.arrayBuffer())]).toEqual([7, 8]);
    expect(inspectPlayableStream).toHaveBeenCalledWith(
      viewer,
      'fast-range-stream',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(mocks.readPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not reopen a local receipt URL after another replica fences recovery', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'fenced-local-url',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const sourceUrl = 'https://media.example/fenced-local-url.mp4';
    const resolveMediaUrl = vi.fn().mockResolvedValue(sourceUrl);
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/fenced' });
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, inspectPlayableStream });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'resolving', epoch: 11 });
    const fetcher = vi.fn(() => Promise.resolve(new Response('first range', { status: 206 })));
    vi.stubGlobal('fetch', fetcher);
    const request = () =>
      new NextRequest('https://vidak.example/api/evault/videos/fenced-local-url', {
        headers: {
          authorization: 'Bearer access-token',
          range: 'bytes=0-1',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      });

    const first = await GET(request(), {
      params: Promise.resolve({ streamId: 'fenced-local-url' }),
    });
    expect(first.status).toBe(206);
    const second = await GET(request(), {
      params: Promise.resolve({ streamId: 'fenced-local-url' }),
    });

    expect(second.status, await second.text()).toBe(503);
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
    expect(inspectPlayableStream).not.toHaveBeenCalled();
    expect(mocks.readPlaybackSourceRefresh).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses another replica’s ready handoff before reopening a stale local source', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'cross-replica-recovery',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const staleUrl = 'https://media.example/stale-local.mp4';
    const recoveredUrl = 'https://media.example/recovered-on-other-replica.mp4';
    const resolveMediaUrl = vi.fn().mockResolvedValue(staleUrl);
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/recovered' });
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl,
      inspectPlayableStream,
      invalidateMediaUrl,
    });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'ready', epoch: 6, mediaUrl: recoveredUrl });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(new Response('initial', { status: 206 })))
      .mockImplementationOnce(() => Promise.resolve(new Response('recovered', { status: 206 })));
    vi.stubGlobal('fetch', fetcher);
    const request = () =>
      new NextRequest('https://vidak.example/api/evault/videos/cross-replica-recovery', {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      });

    const initial = await GET(request(), {
      params: Promise.resolve({ streamId: 'cross-replica-recovery' }),
    });
    expect(initial.status).toBe(206);
    const recovered = await GET(request(), {
      params: Promise.resolve({ streamId: 'cross-replica-recovery' }),
    });

    expect(recovered.status).toBe(206);
    await expect(recovered.text()).resolves.toBe('recovered');
    expect(fetcher).toHaveBeenNthCalledWith(2, recoveredUrl, expect.anything());
    expect(mocks.claimPlaybackSourceRefresh).not.toHaveBeenCalled();
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
    expect(invalidateMediaUrl).not.toHaveBeenCalled();
  });

  it('forgets a freshly resolved local URL when its first upstream open is rejected', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'cold-source-rejection',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const staleUrl = 'https://media.example/cold-stale.mp4';
    const resolveMediaUrl = vi.fn().mockResolvedValue(staleUrl);
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl: vi.fn() });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'unavailable' });
    // The failed source is being recovered elsewhere. The route must not
    // reuse its freshly resolved local URL while that durable fence is live.
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({ kind: 'in_progress' });
    const fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
    vi.stubGlobal('fetch', fetcher);
    const request = () =>
      GET(
        new NextRequest('https://vidak.example/api/evault/videos/cold-source-rejection', {
          headers: {
            authorization: 'Bearer access-token',
            cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
          },
        }),
        { params: Promise.resolve({ streamId: 'cold-source-rejection' }) },
      );

    const first = await request();
    const second = await request();

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a rejected receipt generation fenced when an older resolver lands late', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const streamId = 'late-receipt-resolver-fence';
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId,
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const staleUrl = 'https://media.example/late-stale.mp4';
    const freshUrl = 'https://media.example/late-fresh.mp4';
    let releaseLateResolver: ((url: string) => void) | undefined;
    const lateResolver = new Promise<string>((resolve) => {
      releaseLateResolver = resolve;
    });
    const resolveMediaUrl = vi
      .fn()
      .mockReturnValueOnce(lateResolver)
      .mockResolvedValueOnce(staleUrl)
      .mockResolvedValueOnce(explicitlyExpiringMediaUrl('failed-recovery'));
    const inspectPlayableStream = vi.fn().mockResolvedValue({ fileUri: 'w3ds://file/late-fresh' });
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, inspectPlayableStream });
    // Request A begins at revision 0 and stalls. Request B uses S, observes
    // its rejection, then sees another replica still resolving. Its recovery
    // reads prune all ordinary receipt entries before A is allowed to finish.
    // The next request must consume the ready F1 handoff, never let A put S
    // back into the receipt-local source generation.
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'ready', epoch: 8, mediaUrl: freshUrl });
    // The active owner loses its conditional publish. Its catch path removes
    // the short resolving memo, leaving only the revision tombstone to stop
    // request A from restoring S before C reads F1.
    mocks.publishPlaybackSourceRefresh.mockResolvedValue(false);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response('late stale bytes', { status: 206 }))
      .mockResolvedValueOnce(new Response('fresh handoff bytes', { status: 206 }));
    vi.stubGlobal('fetch', fetcher);
    const request = () =>
      GET(
        new NextRequest(`https://vidak.example/api/evault/videos/${streamId}`, {
          headers: {
            authorization: 'Bearer access-token',
            cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
          },
        }),
        { params: Promise.resolve({ streamId }) },
      );

    const olderRequest = request();
    await vi.waitFor(() => expect(resolveMediaUrl).toHaveBeenCalledTimes(1));
    const rejectedRequest = await request();
    expect(rejectedRequest.status).toBe(503);

    releaseLateResolver?.(staleUrl);
    await expect(olderRequest).resolves.toMatchObject({ status: 206 });

    const afterRecovery = await request();
    expect(afterRecovery.status).toBe(206);
    await expect(afterRecovery.text()).resolves.toBe('fresh handoff bytes');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenNthCalledWith(3, freshUrl, expect.anything());
  });

  it('falls back to a fresh source when a shared initial durable read stalls', async () => {
    vi.useFakeTimers();
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stalled-state-read',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValue('https://media.example/stalled-state-read-fallback.mp4');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.readPlaybackSourceRefresh.mockReturnValue(new Promise(() => undefined));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('fresh bytes', { status: 206 }))),
    );
    const request = () =>
      GET(
        new NextRequest('https://vidak.example/api/evault/videos/stalled-state-read', {
          headers: {
            authorization: 'Bearer access-token',
            cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
          },
        }),
        { params: Promise.resolve({ streamId: 'stalled-state-read' }) },
      );

    try {
      const first = request();
      await vi.advanceTimersByTimeAsync(0);
      const second = request();
      await vi.advanceTimersByTimeAsync(500);
      await expect(first).resolves.toMatchObject({ status: 206 });
      await expect(second).resolves.toMatchObject({ status: 206 });
      expect(mocks.readPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
      expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled recovery publish rather than leaving the media GET pending', async () => {
    vi.useFakeTimers();
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'stalled-publish',
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const resolveMediaUrl = vi.fn().mockResolvedValue(explicitlyExpiringMediaUrl('recovery'));
    mocks.createLibrary.mockReturnValue({ inspectBoundStream: vi.fn(), resolveMediaUrl });
    mocks.readPlaybackSourceRefresh.mockResolvedValue({ kind: 'retryable', epoch: 3 });
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({
      kind: 'acquired',
      lease: { epoch: 4, token: 'stalled-publish-owner', expiresAt: Date.now() + 30_000 },
    });
    mocks.publishPlaybackSourceRefresh.mockReturnValue(new Promise(() => undefined));

    try {
      const pending = GET(
        new NextRequest('https://vidak.example/api/evault/videos/stalled-publish', {
          headers: {
            authorization: 'Bearer access-token',
            cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
          },
        }),
        { params: Promise.resolve({ streamId: 'stalled-publish' }) },
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(750);
      await expect(pending).resolves.toMatchObject({ status: 503 });
      expect(mocks.publishPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
    const recovery = createNoReceiptRecoveryMocks();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl, ...recovery });
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

  it('reuses a ready cross-replica recovery after a long video outlives its browser receipt', async () => {
    const staleUrl = 'https://media.example/expired-long-video.mp4';
    const recoveredUrl = 'https://media.example/recovered-on-another-replica.mp4';
    const resolveMediaUrl = vi.fn().mockResolvedValue(staleUrl);
    const recovery = createNoReceiptRecoveryMocks();
    mocks.readPlaybackSourceRefresh.mockResolvedValue({
      kind: 'ready',
      epoch: 4,
      mediaUrl: recoveredUrl,
    });
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl,
      ...recovery,
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response('recovered bytes', { status: 206 }));
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/receipt-expired-long-video', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'receipt-expired-long-video' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('recovered bytes');
    expect(recovery.proveCurrentPlayableStreamForSourceRefresh).toHaveBeenCalledWith(
      viewer,
      'receipt-expired-long-video',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(mocks.readPlaybackSourceRefresh).toHaveBeenCalledWith({
      receipt: recovery.readReceipt,
      viewerEName: viewer.eName,
      streamId: 'receipt-expired-long-video',
    });
    expect(recovery.adoptReadyPlaybackSourceAfterCurrentProof).toHaveBeenCalledWith(
      viewer,
      'receipt-expired-long-video',
      recovery.proof,
      recoveredUrl,
    );
    expect(fetcher).toHaveBeenNthCalledWith(2, recoveredUrl, expect.anything());
    expect(mocks.claimPlaybackSourceRefresh).not.toHaveBeenCalled();
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
  });

  it('replaces only the exact ready epoch when that durable source is the rejected URL', async () => {
    const staleUrl = 'https://media.example/still-rejected.mp4';
    const refreshedUrl = 'https://media.example/reissued-source.mp4';
    const recovery = createNoReceiptRecoveryMocks();
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce(staleUrl)
      .mockResolvedValueOnce(refreshedUrl);
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, ...recovery });
    mocks.readPlaybackSourceRefresh.mockResolvedValue({
      kind: 'ready',
      epoch: 12,
      mediaUrl: staleUrl,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('new source', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/ready-source-rejected', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'ready-source-rejected' }) },
    );

    expect(response.status).toBe(206);
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'ready-source-rejected',
      replaceReadyEpoch: 12,
    });
    expect(resolveMediaUrl).toHaveBeenLastCalledWith(
      viewer,
      'ready-source-rejected',
      expect.objectContaining({
        forceSourceRefresh: true,
        forcedSourceRefreshProof: recovery.proof,
      }),
    );
  });

  it('replaces a receipt-bound rejected ready epoch and publishes its forced source', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const streamId = 'receipt-ready-epoch-replacement';
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId,
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const staleUrl = 'https://media.example/receipt-ready-stale.mp4';
    const freshUrl = explicitlyExpiringMediaUrl('receipt-ready-fresh');
    const resolveMediaUrl = vi.fn().mockResolvedValueOnce(staleUrl).mockResolvedValueOnce(freshUrl);
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'ready', epoch: 21, mediaUrl: staleUrl });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('fresh bytes', { status: 206 })),
    );

    const response = await GET(
      new NextRequest(`https://vidak.example/api/evault/videos/${streamId}`, {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('fresh bytes');
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId,
      replaceReadyEpoch: 21,
    });
    expect(mocks.publishPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
    expect(resolveMediaUrl).toHaveBeenLastCalledWith(
      viewer,
      streamId,
      expect.objectContaining({ forceSourceRefresh: true }),
    );
  });

  it('adopts a fresh receipt handoff when another replica wins the ready-epoch claim', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
    const streamId = 'receipt-ready-claim-winner';
    const receipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId,
      env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
    });
    const staleUrl = 'https://media.example/receipt-claim-stale.mp4';
    const winnerUrl = 'https://media.example/receipt-claim-winner.mp4';
    const resolveMediaUrl = vi.fn().mockResolvedValue(staleUrl);
    const inspectPlayableStream = vi
      .fn()
      .mockResolvedValue({ fileUri: 'w3ds://file/receipt-winner' });
    const adoptReadyPlaybackSourceAfterAuthorizationReceipt = vi.fn().mockReturnValue(true);
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl,
      inspectPlayableStream,
      adoptReadyPlaybackSourceAfterAuthorizationReceipt,
    });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'ready', epoch: 22, mediaUrl: staleUrl })
      .mockResolvedValueOnce({ kind: 'ready', epoch: 23, mediaUrl: winnerUrl });
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({ kind: 'in_progress' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('winner bytes', { status: 206 })),
    );

    const response = await GET(
      new NextRequest(`https://vidak.example/api/evault/videos/${streamId}`, {
        headers: {
          authorization: 'Bearer access-token',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${receipt}`,
        },
      }),
      { params: Promise.resolve({ streamId }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('winner bytes');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId,
      replaceReadyEpoch: 22,
    });
    expect(adoptReadyPlaybackSourceAfterAuthorizationReceipt).toHaveBeenCalledWith(
      viewer,
      streamId,
      receipt,
      winnerUrl,
    );
  });

  it('rereads and uses a newer ready handoff when a concurrent replica wins the claim', async () => {
    const staleUrl = 'https://media.example/claim-race-stale.mp4';
    const recoveredUrl = 'https://media.example/claim-race-fresh.mp4';
    const recovery = createNoReceiptRecoveryMocks();
    const resolveMediaUrl = vi.fn().mockResolvedValue(staleUrl);
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, ...recovery });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'ready', epoch: 13, mediaUrl: recoveredUrl });
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({ kind: 'in_progress' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('handoff bytes', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/claim-race-ready', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'claim-race-ready' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('handoff bytes');
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'claim-race-ready',
    });
    expect(mocks.readPlaybackSourceRefresh).toHaveBeenCalledTimes(2);
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
    expect(recovery.adoptReadyPlaybackSourceAfterCurrentProof).toHaveBeenCalledWith(
      viewer,
      'claim-race-ready',
      recovery.proof,
      recoveredUrl,
    );
  });

  it('adopts a fresh no-receipt handoff when the durable state is resolving', async () => {
    const streamId = 'no-receipt-resolving-winner';
    const staleUrl = 'https://media.example/no-receipt-resolving-stale.mp4';
    const winnerUrl = 'https://media.example/no-receipt-resolving-winner.mp4';
    const recovery = createNoReceiptRecoveryMocks();
    const resolveMediaUrl = vi.fn().mockResolvedValue(staleUrl);
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, ...recovery });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'resolving', epoch: 31 })
      .mockResolvedValueOnce({ kind: 'ready', epoch: 32, mediaUrl: winnerUrl });
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({ kind: 'in_progress' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('winner bytes', { status: 206 })),
    );

    const response = await GET(
      new NextRequest(`https://vidak.example/api/evault/videos/${streamId}`, {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('winner bytes');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
    expect(recovery.adoptReadyPlaybackSourceAfterCurrentProof).toHaveBeenCalledWith(
      viewer,
      streamId,
      recovery.proof,
      winnerUrl,
    );
  });

  it('uses the durable winner when this no-receipt recovery loses its publish lease', async () => {
    const staleUrl = 'https://media.example/late-owner-stale.mp4';
    const localLateUrl = explicitlyExpiringMediaUrl('late-owner-local');
    const winnerUrl = 'https://media.example/late-owner-winner.mp4';
    const recovery = createNoReceiptRecoveryMocks();
    const discardLocalForcedSourceResult = vi.fn();
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce(staleUrl)
      .mockResolvedValueOnce(localLateUrl);
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl,
      discardLocalForcedSourceResult,
      ...recovery,
    });
    mocks.readPlaybackSourceRefresh
      .mockResolvedValueOnce({ kind: 'absent' })
      .mockResolvedValueOnce({ kind: 'ready', epoch: 14, mediaUrl: winnerUrl });
    mocks.publishPlaybackSourceRefresh.mockResolvedValue(false);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('winner bytes', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/late-owner-winner', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'late-owner-winner' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('winner bytes');
    expect(discardLocalForcedSourceResult).toHaveBeenCalledWith(viewer, 'late-owner-winner');
    expect(recovery.adoptReadyPlaybackSourceAfterCurrentProof).toHaveBeenCalledWith(
      viewer,
      'late-owner-winner',
      recovery.proof,
      winnerUrl,
    );
    expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
  });

  it('serializes no-receipt recovery after a long video outlives its receipt window', async () => {
    const staleUrl = 'https://media.example/long-video-expired.mp4';
    const freshUrl = explicitlyExpiringMediaUrl('long-video-fresh');
    let finishForcedResolution: ((url: string) => void) | undefined;
    const resolveMediaUrl = vi.fn((_user, _streamId, options?: { forceSourceRefresh?: boolean }) =>
      options?.forceSourceRefresh
        ? new Promise<string>((resolve) => {
            finishForcedResolution = resolve;
          })
        : Promise.resolve(staleUrl),
    );
    const invalidateMediaUrl = vi.fn();
    const recovery = createNoReceiptRecoveryMocks();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl, ...recovery });
    mocks.claimPlaybackSourceRefresh
      .mockResolvedValueOnce({
        kind: 'acquired',
        lease: { epoch: 1, token: 'long-video-owner', expiresAt: Date.now() + 30_000 },
      })
      .mockResolvedValueOnce({ kind: 'in_progress' });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 403 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 403 })))
      .mockImplementationOnce(() => Promise.resolve(new Response('fresh', { status: 206 })));
    vi.stubGlobal('fetch', fetcher);
    const request = () =>
      GET(
        new NextRequest('https://vidak.example/api/evault/videos/long-video-stream', {
          headers: { authorization: 'Bearer access-token' },
        }),
        { params: Promise.resolve({ streamId: 'long-video-stream' }) },
      );

    const first = request();
    const second = request();
    await vi.waitFor(() => expect(resolveMediaUrl).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledTimes(2));
    finishForcedResolution?.(freshUrl);

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort()).toEqual([206, 503]);
    expect(resolveMediaUrl).toHaveBeenCalledTimes(3);
    expect(mocks.publishPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
    expect(invalidateMediaUrl).toHaveBeenCalledTimes(2);
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
    const recovery = createNoReceiptRecoveryMocks();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl, ...recovery });
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
    const recovery = createNoReceiptRecoveryMocks();
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl,
      renewPlayableStream,
      invalidateMediaUrl,
      ...recovery,
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

  it('records a confirmed terminal shared denial from an actual media request', async () => {
    const bindingHash = 'b'.repeat(43);
    const terminalDenial = new EVaultVideoLibraryError(
      'The viewer no longer has access.',
      'authorization_denied',
      403,
      undefined,
      bindingHash,
    );
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl: vi.fn().mockRejectedValue(terminalDenial),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/revoked-shared-stream', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'revoked-shared-stream' }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authorization_denied' },
    });
    expect(mocks.recordConfirmedSharedPlaybackDenial).toHaveBeenCalledWith(terminalDenial);
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

function resolvesWithinTestDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Playback response waited for a local byte-cache fast path.')),
      100,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
