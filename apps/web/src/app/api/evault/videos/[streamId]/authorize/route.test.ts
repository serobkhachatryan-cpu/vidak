import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
  putPlaybackResolutionCache: vi.fn(),
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

import { EVaultVideoLibraryError } from '../../../../../../server/evault-video-library';
import { setOperationalLogSinkForTests } from '../../../../../../server/ops-observability';
import {
  sharedVideoAuthorizationReceiptCookieName,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../../server/shared-video-authorization-receipt';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };
const receiptSecret = 'shared-video-receipt-route-test-secret-0123456789';
let operationalLogs: string[] = [];

describe('eVault video authorization warm-up route', () => {
  beforeEach(() => {
    operationalLogs = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
    mocks.putPlaybackResolutionCache.mockReset();
    mocks.putPlaybackResolutionCache.mockResolvedValue(true);
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
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
    const receipt = response.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value;
    expect(receipt).toBeDefined();
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
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'stream-1',
      expect.objectContaining({ priority: 'interactive', onTiming: expect.any(Function) }),
    );
  });

  it('uses an isolated cancellable remote resolution for a hover warmup', async () => {
    const authorizePlayableStream = vi.fn().mockResolvedValue(undefined);
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });
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

  it('stores a resolved private URL only after minting a verified receipt', async () => {
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
    expect(mocks.putPlaybackResolutionCache).toHaveBeenCalledWith({
      receipt,
      viewerEName: viewer.eName,
      streamId: 'stream-1',
      mediaUrl: privateMediaUrl,
    });
    expect(JSON.stringify(operationalLogs)).not.toContain(privateMediaUrl);
    expect(JSON.stringify(operationalLogs)).not.toContain('source-token');
  });

  it('returns the verified receipt without waiting for a pending durable cache write', async () => {
    const privateMediaUrl = 'https://media.example/private.mp4?source-token=server-only';
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    let finishCacheWrite: ((value: boolean) => void) | undefined;
    const pendingCacheWrite = new Promise<boolean>((resolve) => {
      finishCacheWrite = resolve;
    });
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });
    mocks.putPlaybackResolutionCache.mockReturnValue(pendingCacheWrite);

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
    expect(mocks.putPlaybackResolutionCache).toHaveBeenCalledWith(
      expect.objectContaining({
        viewerEName: viewer.eName,
        streamId: 'stream-1',
        mediaUrl: privateMediaUrl,
      }),
    );
    finishCacheWrite?.(true);
  });

  it('keeps a completed authorization successful when the cache write fails', async () => {
    const privateMediaUrl = 'https://media.example/private.mp4?source-token=server-only';
    const authorizePlayableStream = vi.fn().mockResolvedValue(privateMediaUrl);
    mocks.createLibrary.mockReturnValue({ authorizePlayableStream });
    mocks.putPlaybackResolutionCache.mockRejectedValue(
      new Error(`cache unavailable for ${privateMediaUrl}`),
    );

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
    expect(mocks.putPlaybackResolutionCache).toHaveBeenCalledTimes(1);
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
