import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
  putPlaybackResolutionCache: vi.fn(),
  claimPlaybackSourceRefresh: vi.fn(),
  failPlaybackSourceRefresh: vi.fn(),
  publishPlaybackSourceRefresh: vi.fn(),
  readPlaybackSourceRefresh: vi.fn(),
  releasePlaybackSourceRefresh: vi.fn(),
  recordConfirmedSharedPlaybackDenial: vi.fn(),
}));

vi.mock('../../../../../../server/evault-video-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../server/evault-video-library')>()),
  createEVaultVideoLibrary: mocks.createLibrary,
}));

vi.mock('../../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

vi.mock('../../../../../../server/playback-resolution-cache', () => ({
  putPlaybackResolutionCache: mocks.putPlaybackResolutionCache,
}));

vi.mock('../../../../../../server/playback-source-refresh', () => ({
  claimPlaybackSourceRefresh: mocks.claimPlaybackSourceRefresh,
  failPlaybackSourceRefresh: mocks.failPlaybackSourceRefresh,
  publishPlaybackSourceRefresh: mocks.publishPlaybackSourceRefresh,
  readPlaybackSourceRefresh: mocks.readPlaybackSourceRefresh,
  releasePlaybackSourceRefresh: mocks.releasePlaybackSourceRefresh,
}));

vi.mock('../../../../../../server/video-space/shared-playback-card-quarantine', () => ({
  recordConfirmedSharedPlaybackDenial: mocks.recordConfirmedSharedPlaybackDenial,
}));

import { EVaultVideoLibraryError } from '../../../../../../server/evault-video-library';
import { setOperationalLogSinkForTests } from '../../../../../../server/ops-observability';
import {
  sharedVideoAuthorizationReceiptCookieName,
  sharedVideoStreamAuthorizationReceiptCookieName,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../../server/shared-video-authorization-receipt';
import { w3dsAccessCookieName } from '../../../../../../server/w3ds-auth';
import { forcedSourceRefreshHandoffTimeoutMs, GET, POST } from './route';

const viewer = { eName: '@viewer.w3id' };
const receiptSecret = 'shared-video-receipt-route-test-secret-0123456789';
const forcedLease = {
  epoch: 1,
  token: 'forced-refresh-lease-token-123456',
  expiresAt: 2_000_000_000_000,
};
const forcedSourceRefreshProof = Object.freeze({});
let operationalLogs: string[] = [];

function createForcedSourceRefreshProof() {
  return vi.fn().mockResolvedValue(forcedSourceRefreshProof);
}

function explicitlyExpiringMediaUrl(name: string): string {
  return `https://media.example/${name}.mp4?expires=${Math.floor(
    (Date.now() + 120_000) / 1_000,
  )}&signature=test-source`;
}

describe('eVault video authorization warm-up route', () => {
  beforeEach(() => {
    operationalLogs = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
    mocks.putPlaybackResolutionCache.mockReset();
    mocks.putPlaybackResolutionCache.mockResolvedValue(true);
    mocks.claimPlaybackSourceRefresh.mockReset();
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({
      kind: 'acquired',
      lease: forcedLease,
    });
    mocks.failPlaybackSourceRefresh.mockReset();
    mocks.failPlaybackSourceRefresh.mockResolvedValue(true);
    mocks.releasePlaybackSourceRefresh.mockReset();
    mocks.releasePlaybackSourceRefresh.mockResolvedValue(true);
    mocks.publishPlaybackSourceRefresh.mockReset();
    mocks.publishPlaybackSourceRefresh.mockResolvedValue(true);
    mocks.readPlaybackSourceRefresh.mockReset();
    mocks.readPlaybackSourceRefresh.mockResolvedValue({
      kind: 'ready',
      epoch: 1,
      mediaUrl: 'https://media.example/refreshed.mp4',
    });
    mocks.recordConfirmedSharedPlaybackDenial.mockReset();
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
    });
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', receiptSecret);
  });

  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('warms authorization without downloading media bytes', async () => {
    const authorizePlayableStream = vi.fn().mockResolvedValue(undefined);
    mocks.createLibrary.mockReturnValue({
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const receipt = response.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value;
    const streamReceipt = response.cookies.get(
      sharedVideoStreamAuthorizationReceiptCookieName,
    )?.value;
    expect(receipt).toBeDefined();
    expect(streamReceipt).toBe(receipt);
    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt,
        viewerEName: viewer.eName,
        streamId: 'stream-1',
        env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
      }),
    ).toBe(true);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain('Max-Age=45');
    const streamCookie = response.cookies
      .getAll()
      .find((cookie) => cookie.name === sharedVideoStreamAuthorizationReceiptCookieName);
    expect(streamCookie).toMatchObject({ path: '/api/evault/videos/stream-1' });
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({
        priority: 'interactive',
        allowExtendedLegacyFileMetadataWait: true,
        onTiming: expect.any(Function),
      }),
    );
  });

  it('uses an isolated cancellable remote resolution for a hover warmup', async () => {
    const authorizePlayableStream = vi.fn().mockResolvedValue(undefined);
    mocks.createLibrary.mockReturnValue({
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
    });
    const request = new NextRequest(
      'https://vidak.example/api/evault/videos/stream-1/authorize?priority=warmup',
      { headers: { authorization: 'Bearer access-token' } },
    );

    const response = await GET(request, { params: Promise.resolve({ streamId: 'stream-1' }) });

    expect(response.status).toBe(204);
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({
        priority: 'warmup',
        signal: request.signal,
        onTiming: expect.any(Function),
      }),
    );
  });

  it('claims, resolves, publishes, and then issues a receipt for an explicit recovery', async () => {
    const privateMediaUrl = explicitlyExpiringMediaUrl('refreshed');
    const calls: string[] = [];
    const proveCurrentPlayableStreamForSourceRefresh = vi.fn(() => {
      calls.push('preflight');
      return Promise.resolve(forcedSourceRefreshProof);
    });
    const authorizePlayableStream = vi.fn(() => {
      calls.push('resolve');
      return Promise.resolve(privateMediaUrl);
    });
    const inspectBoundStream = vi.fn(() => {
      calls.push('inspect');
    });
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream,
      proveCurrentPlayableStreamForSourceRefresh,
      authorizePlayableStream,
    });
    mocks.claimPlaybackSourceRefresh.mockImplementation(async () => {
      calls.push('claim');
      return { kind: 'acquired', lease: forcedLease };
    });
    mocks.publishPlaybackSourceRefresh.mockImplementation(async () => {
      calls.push('publish');
      return true;
    });
    mocks.readPlaybackSourceRefresh.mockImplementation(async () => {
      calls.push('read');
      return { kind: 'ready', epoch: forcedLease.epoch, mediaUrl: privateMediaUrl };
    });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({
        priority: 'interactive',
        forceSourceRefresh: true,
        forcedSourceRefreshProof,
        onTiming: expect.any(Function),
      }),
    );
    const receipt = response.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value;
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
    });
    expect(mocks.publishPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      lease: expect.objectContaining({ epoch: 1 }),
      mediaUrl: privateMediaUrl,
    });
    expect(mocks.readPlaybackSourceRefresh).toHaveBeenCalledWith({
      receipt,
      viewerEName: viewer.eName,
      streamId: 'stream-1',
    });
    expect(mocks.putPlaybackResolutionCache).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).not.toContain('shared-video-source-refresh');
    expect(calls).toEqual(['inspect', 'claim', 'preflight', 'resolve', 'publish', 'read']);
  });

  it('accepts a same-origin cookie-authenticated recovery POST', async () => {
    const privateMediaUrl = explicitlyExpiringMediaUrl('refreshed');
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    const getSession = vi.fn().mockResolvedValue({ user: viewer });
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
    });
    mocks.getAuthService.mockReturnValue({ getSession });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: {
          cookie: `${w3dsAccessCookieName}=access-token`,
          origin: 'https://vidak.example',
          'sec-fetch-site': 'same-origin',
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    expect(getSession).toHaveBeenCalledWith('access-token');
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
    });
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value).toBeDefined();
  });

  it('does not force-refresh a healthy durable handoff from a browser recovery POST', async () => {
    const proveCurrentPlayableStreamForSourceRefresh = createForcedSourceRefreshProof();
    const authorizePlayableStream = vi.fn();
    const discardLocalForcedSourceResult = vi.fn();
    const inspectBoundStream = vi.fn();
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream,
      proveCurrentPlayableStreamForSourceRefresh,
      authorizePlayableStream,
      discardLocalForcedSourceResult,
    });
    // A healthy ready row rejects a plain POST claim. Only the media GET
    // supplies an exact rejected epoch, so this must not clear or resolve a
    // new upstream source merely because a client retried recovery.
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({ kind: 'in_progress' });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'remote_unavailable' },
    });
    expect(mocks.createLibrary).toHaveBeenCalledTimes(1);
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
    });
    expect(inspectBoundStream).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(proveCurrentPlayableStreamForSourceRefresh).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(authorizePlayableStream).not.toHaveBeenCalled();
    expect(discardLocalForcedSourceResult).not.toHaveBeenCalled();
  });

  it('validates the sealed stream locally before claiming a durable recovery row', async () => {
    const inspectBoundStream = vi.fn(() => {
      throw new EVaultVideoLibraryError('The stream is invalid.', 'invalid_stream', 400);
    });
    const proveCurrentPlayableStreamForSourceRefresh = createForcedSourceRefreshProof();
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream,
      proveCurrentPlayableStreamForSourceRefresh,
    });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/not-a-bound-stream/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'not-a-bound-stream' }) },
    );

    expect(response.status).toBe(400);
    expect(inspectBoundStream).toHaveBeenCalledWith(viewer, 'not-a-bound-stream');
    expect(proveCurrentPlayableStreamForSourceRefresh).not.toHaveBeenCalled();
    expect(mocks.claimPlaybackSourceRefresh).not.toHaveBeenCalled();
  });

  it('cannot let a recently revoked shared viewer churn forced recovery state', async () => {
    const proveCurrentPlayableStreamForSourceRefresh = vi
      .fn()
      .mockRejectedValue(
        new EVaultVideoLibraryError(
          'The viewer no longer has access.',
          'authorization_denied',
          403,
        ),
      );
    const authorizePlayableStream = vi.fn();
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh,
      authorizePlayableStream,
    });

    const request = () =>
      POST(
        new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
          method: 'POST',
          headers: { authorization: 'Bearer access-token' },
        }),
        { params: Promise.resolve({ streamId: 'stream-1' }) },
      );

    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    expect(proveCurrentPlayableStreamForSourceRefresh).toHaveBeenCalledTimes(2);
    expect(proveCurrentPlayableStreamForSourceRefresh).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(mocks.claimPlaybackSourceRefresh).toHaveBeenCalledTimes(2);
    expect(mocks.releasePlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      lease: forcedLease,
    });
    expect(authorizePlayableStream).not.toHaveBeenCalled();
  });

  it('preserves and retires a confirmed revoked share when a refresh lease is busy', async () => {
    const bindingHash = 'a'.repeat(43);
    const terminalDenial = new EVaultVideoLibraryError(
      'The viewer no longer has access.',
      'authorization_denied',
      403,
      undefined,
      bindingHash,
    );
    const proveCurrentPlayableStreamForSourceRefresh = vi.fn().mockRejectedValue(terminalDenial);
    const authorizePlayableStream = vi.fn();
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh,
      authorizePlayableStream,
    });
    mocks.claimPlaybackSourceRefresh.mockResolvedValue({ kind: 'in_progress' });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authorization_denied' },
    });
    expect(proveCurrentPlayableStreamForSourceRefresh).toHaveBeenCalledTimes(1);
    expect(authorizePlayableStream).not.toHaveBeenCalled();
    expect(mocks.recordConfirmedSharedPlaybackDenial).toHaveBeenCalledWith(terminalDenial);
  });

  it('releases its lease when source resolution fails after a successful claim', async () => {
    const proveCurrentPlayableStreamForSourceRefresh = createForcedSourceRefreshProof();
    const authorizePlayableStream = vi
      .fn()
      .mockRejectedValue(
        new EVaultVideoLibraryError('The source is unavailable.', 'remote_unavailable', 503),
      );
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh,
      authorizePlayableStream,
    });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.releasePlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      lease: forcedLease,
    });
  });

  it('bounds a blocked durable claim, then performs one entitlement classification', async () => {
    vi.useFakeTimers();
    const proveCurrentPlayableStreamForSourceRefresh = createForcedSourceRefreshProof();
    const authorizePlayableStream = vi.fn();
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh,
      authorizePlayableStream,
    });
    mocks.claimPlaybackSourceRefresh.mockReturnValue(new Promise(() => undefined));

    try {
      const pending = POST(
        new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
          method: 'POST',
          headers: { authorization: 'Bearer access-token' },
        }),
        { params: Promise.resolve({ streamId: 'stream-1' }) },
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(forcedSourceRefreshHandoffTimeoutMs);

      const response = await pending;
      expect(response.status).toBe(503);
      expect(proveCurrentPlayableStreamForSourceRefresh).toHaveBeenCalledTimes(1);
      expect(authorizePlayableStream).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a lease that arrives after the bounded claim deadline', async () => {
    vi.useFakeTimers();
    let completeClaim:
      | ((claim: { kind: 'acquired'; lease: typeof forcedLease }) => void)
      | undefined;
    mocks.claimPlaybackSourceRefresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeClaim = resolve;
        }),
    );

    try {
      const pending = POST(
        new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
          method: 'POST',
          headers: { authorization: 'Bearer access-token' },
        }),
        { params: Promise.resolve({ streamId: 'stream-1' }) },
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(forcedSourceRefreshHandoffTimeoutMs);
      await expect(pending).resolves.toMatchObject({ status: 503 });

      completeClaim?.({ kind: 'acquired', lease: forcedLease });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.releasePlaybackSourceRefresh).toHaveBeenCalledWith({
        viewerEName: viewer.eName,
        streamId: 'stream-1',
        lease: forcedLease,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not issue a late receipt after another replica advances the epoch', async () => {
    const authorizePlayableStream = vi
      .fn()
      .mockResolvedValue(explicitlyExpiringMediaUrl('refreshed'));
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
    });
    mocks.readPlaybackSourceRefresh.mockResolvedValue({ kind: 'resolving', epoch: 2 });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(503);
    expect(mocks.publishPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.releasePlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      lease: forcedLease,
    });
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)).toBeUndefined();
  });

  it('does not let a speculative warmup evict a shared media source', async () => {
    const invalidateMediaUrl = vi.fn();
    const authorizePlayableStream = vi.fn().mockResolvedValue(undefined);
    mocks.createLibrary.mockReturnValue({ invalidateMediaUrl, authorizePlayableStream });
    const request = new NextRequest(
      'https://vidak.example/api/evault/videos/stream-1/authorize?priority=warmup&refresh=source',
      { headers: { authorization: 'Bearer access-token' } },
    );

    const response = await GET(request, { params: Promise.resolve({ streamId: 'stream-1' }) });

    expect(response.status).toBe(204);
    expect(invalidateMediaUrl).not.toHaveBeenCalled();
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ priority: 'warmup', signal: request.signal }),
    );
    expect(authorizePlayableStream).not.toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ forceSourceRefresh: true }),
    );
  });

  it('treats a browser-controlled GET refresh query as an ordinary warmup', async () => {
    const authorizePlayableStream = vi.fn().mockResolvedValue(undefined);
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize?refresh=source', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(authorizePlayableStream).not.toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ forceSourceRefresh: true }),
    );
  });

  it('rejects a cookie-authenticated recovery POST without a trusted origin', async () => {
    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { cookie: `${w3dsAccessCookieName}=access-token` },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'untrusted_origin' } });
    expect(mocks.createLibrary).not.toHaveBeenCalled();
    expect(mocks.getAuthService).not.toHaveBeenCalled();
  });

  it('rejects a cookie-authenticated recovery POST from an untrusted origin', async () => {
    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: {
          cookie: `${w3dsAccessCookieName}=access-token`,
          origin: 'https://attacker.example',
          'sec-fetch-site': 'cross-site',
        },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'untrusted_origin' } });
    expect(mocks.createLibrary).not.toHaveBeenCalled();
    expect(mocks.getAuthService).not.toHaveBeenCalled();
  });

  it('does not issue a recovery receipt until its winner epoch is durably published', async () => {
    const privateMediaUrl = explicitlyExpiringMediaUrl('refreshed');
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    let completePublish: ((value: boolean) => void) | undefined;
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
    });
    mocks.publishPlaybackSourceRefresh.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          completePublish = resolve;
        }),
    );

    let settled = false;
    const pending = POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    ).then((response) => {
      settled = true;
      return response;
    });

    await vi.waitFor(() => expect(completePublish).toBeTypeOf('function'));
    expect(settled).toBe(false);
    completePublish?.(true);
    const response = await pending;

    expect(response.status).toBe(204);
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value).toBeDefined();
    expect(response.headers.get('set-cookie')).not.toContain('shared-video-source-refresh');
  });

  it('bounds a blocked forced durable handoff and handles its late completion', async () => {
    vi.useFakeTimers();
    const privateMediaUrl = explicitlyExpiringMediaUrl('refreshed');
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    let finishPublish: ((value: boolean) => void) | undefined;
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
    });
    mocks.publishPlaybackSourceRefresh.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishPublish = resolve;
        }),
    );

    try {
      const pending = POST(
        new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
          method: 'POST',
          headers: { authorization: 'Bearer access-token' },
        }),
        { params: Promise.resolve({ streamId: 'stream-1' }) },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.publishPlaybackSourceRefresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(forcedSourceRefreshHandoffTimeoutMs);
      const response = await pending;

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'remote_unavailable' },
      });
      finishPublish?.(true);
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when a forced recovery cannot durably hand off its fresh source', async () => {
    const privateMediaUrl = explicitlyExpiringMediaUrl('refreshed');
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    const discardLocalForcedSourceResult = vi.fn();
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
      discardLocalForcedSourceResult,
    });
    mocks.publishPlaybackSourceRefresh.mockResolvedValue(false);

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'remote_unavailable' },
    });
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)).toBeUndefined();
    expect(mocks.releasePlaybackSourceRefresh).toHaveBeenCalledWith({
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      lease: forcedLease,
    });
    expect(discardLocalForcedSourceResult).toHaveBeenCalledWith(viewer, 'stream-1');
  });

  it('fences its local forced source when a newer epoch wins after publish', async () => {
    const privateMediaUrl = explicitlyExpiringMediaUrl('older-winner');
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    const discardLocalForcedSourceResult = vi.fn();
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream: vi.fn(),
      proveCurrentPlayableStreamForSourceRefresh: createForcedSourceRefreshProof(),
      authorizePlayableStream,
      discardLocalForcedSourceResult,
    });
    // The conditional publish succeeded, but the final durable re-read sees
    // a newer replica's epoch before this response can set its receipt.
    mocks.readPlaybackSourceRefresh.mockResolvedValue({
      kind: 'ready',
      epoch: forcedLease.epoch + 1,
      mediaUrl: 'https://media.example/newer-winner.mp4',
    });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        method: 'POST',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(503);
    expect(discardLocalForcedSourceResult).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)).toBeUndefined();
  });

  it('sets a verified receipt without writing the retired receipt URL cache', async () => {
    const privateMediaUrl = 'https://media.example/private.mp4?source-token=server-only';
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    const receipt = response.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value;
    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt,
        viewerEName: viewer.eName,
        streamId: 'stream-1',
        env: { W3DS_AUTH_JWT_SECRET: receiptSecret },
      }),
    ).toBe(true);
    expect(mocks.putPlaybackResolutionCache).not.toHaveBeenCalled();
    expect(JSON.stringify(operationalLogs)).not.toContain(privateMediaUrl);
    expect(JSON.stringify(operationalLogs)).not.toContain('source-token');
  });

  it('does not read or write the retired cache during an ordinary warmup', async () => {
    const privateMediaUrl = 'https://media.example/stale-local.mp4?source-token=server-only';
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    expect(mocks.readPlaybackSourceRefresh).not.toHaveBeenCalled();
    expect(mocks.putPlaybackResolutionCache).not.toHaveBeenCalled();
  });

  it('returns the verified receipt without scheduling a retired cache write', async () => {
    const privateMediaUrl = 'https://media.example/private.mp4?source-token=server-only';
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });

    const response = await resolvesWithinTestDeadline(
      GET(
        new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
          headers: { authorization: 'Bearer access-token' },
        }),
        { params: Promise.resolve({ streamId: 'stream-1' }) },
      ),
    );

    expect(response.status).toBe(204);
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value).toBeDefined();
    expect(mocks.putPlaybackResolutionCache).not.toHaveBeenCalled();
  });

  it('keeps a completed authorization successful without the retired cache layer', async () => {
    const privateMediaUrl = 'https://media.example/private.mp4?source-token=server-only';
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });

    const response = await resolvesWithinTestDeadline(
      GET(
        new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
          headers: { authorization: 'Bearer access-token' },
        }),
        { params: Promise.resolve({ streamId: 'stream-1' }) },
      ),
    );

    expect(response.status).toBe(204);
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value).toBeDefined();
    expect(mocks.putPlaybackResolutionCache).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(JSON.stringify(operationalLogs)).not.toContain(privateMediaUrl);
    expect(JSON.stringify(operationalLogs)).not.toContain('source-token');
  });

  it('keeps a successful warmup available when receipt configuration is absent in dev/test', async () => {
    vi.unstubAllEnvs();
    const authorizePlayableStream = vi
      .fn()
      .mockResolvedValue('https://media.example/private.mp4?source-token=server-only');
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1/authorize', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ priority: 'interactive' }),
    );
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)).toBeUndefined();
    expect(mocks.putPlaybackResolutionCache).not.toHaveBeenCalled();
  });

  it('does not dereference the remote source for a legacy viewport warm-up', async () => {
    const authorizePlayableStream = vi.fn().mockResolvedValue(undefined);
    const inspectBoundStream = vi.fn();
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream, inspectBoundStream });

    const response = await GET(
      new NextRequest(
        'https://vidak.example/api/evault/videos/stream-1/authorize?priority=background',
        {
          headers: { authorization: 'Bearer access-token' },
        },
      ),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(204);
    expect(inspectBoundStream).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(authorizePlayableStream).not.toHaveBeenCalled();
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)).toBeUndefined();
    expect(mocks.putPlaybackResolutionCache).not.toHaveBeenCalled();
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

  it('records only fixed, redacted authorization timing fields', async () => {
    const sourceUrl = 'https://media.example/private.mp4?token=source-secret';
    const authorizePlayableStream = vi.fn(
      (
        _user: unknown,
        _streamId: unknown,
        options?: {
          onTiming?: (timing: Record<string, unknown>) => void;
          onAuthorizationContext?: (context: Record<string, unknown>) => void;
        },
      ) => {
        options?.onAuthorizationContext?.({
          accessBasis: 'history',
          proofKind: 'direct_group',
          sharedProofDeadlineMs: 8_000,
        });
        options?.onTiming?.({
          mediaUrlCacheHit: false,
          sharedAccessVerificationMs: 8,
          eVaultResolutionMs: 13,
          directFileDereferenceMs: 5,
          platformTokenMs: 2,
          metadataReadMs: 0,
          sourceUrl,
        });
        return Promise.resolve();
      },
    );
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/private-stream/authorize', {
        headers: {
          authorization: 'Bearer access-token',
          'x-request-id': 'authorization-timing-1',
        },
      }),
      { params: Promise.resolve({ streamId: 'private-stream' }) },
    );

    expect(response.status).toBe(204);
    const events = operationalLogs.map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'authorization-timing-1',
      code: 'media_authorization_timing',
      timing: {
        mode: 'interactive',
        succeeded: true,
        accessBasis: 'history',
        proofKind: 'direct_group',
        sharedProofDeadlineMs: 8_000,
        sessionValidationMs: expect.any(Number),
        authorizationResolutionMs: expect.any(Number),
        mediaUrlCacheHit: false,
        sharedAccessVerificationMs: 8,
        eVaultResolutionMs: 13,
        directFileDereferenceMs: 5,
        platformTokenMs: 2,
        metadataReadMs: 0,
        requestCompletedMs: expect.any(Number),
      },
    });
    expect(events[0].timing.failureKind).toBeUndefined();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('private-stream');
    expect(serialized).not.toContain('@viewer.w3id');
    expect(serialized).not.toContain('access-token');
    expect(serialized).not.toContain('source-secret');
  });

  it('keeps a failed source retryable while logging only its coarse failure kind', async () => {
    const authorizePlayableStream = vi.fn(
      (
        _user: unknown,
        _streamId: unknown,
        options?: {
          onTiming?: (timing: Record<string, unknown>) => void;
          onAuthorizationContext?: (context: Record<string, unknown>) => void;
        },
      ) => {
        options?.onAuthorizationContext?.({
          accessBasis: 'history',
          proofKind: 'direct_group',
          sharedProofDeadlineMs: 8_000,
        });
        options?.onTiming?.({
          mediaUrlCacheHit: false,
          sharedAccessVerificationMs: 8_000,
          eVaultResolutionMs: 0,
          directFileDereferenceMs: 0,
          platformTokenMs: 0,
          metadataReadMs: 0,
        });
        return Promise.reject(
          new EVaultVideoLibraryError(
            'The private eVault source did not answer.',
            'remote_unavailable',
            503,
          ),
        );
      },
    );
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/private-stream/authorize', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ streamId: 'private-stream' }) },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'remote_unavailable' },
    });
    expect(response.cookies.get(sharedVideoAuthorizationReceiptCookieName)).toBeUndefined();
    const events = operationalLogs.map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: 'media_authorization_timing',
      timing: {
        mode: 'interactive',
        succeeded: false,
        failureKind: 'source_unavailable',
        accessBasis: 'history',
        proofKind: 'direct_group',
        sharedProofDeadlineMs: 8_000,
        sharedAccessVerificationMs: 8_000,
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('private-stream');
    expect(serialized).not.toContain('private eVault source');
  });
});

function resolvesWithinTestDeadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Authorization response waited for cache write.')),
      100,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
