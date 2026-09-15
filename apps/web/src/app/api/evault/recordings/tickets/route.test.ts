import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  assertTrustedMutationOrigin: vi.fn(),
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
  issueTicket: vi.fn(),
  recordConfirmedSharedPlaybackDenial: vi.fn(),
}));

vi.mock('../../../../../server/evault-video-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/evault-video-library')>()),
  createEVaultVideoLibrary: mocks.createLibrary,
}));

vi.mock('../../../../../server/recording-concat-ticket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/recording-concat-ticket')>()),
  issueRecordingConcatTicket: mocks.issueTicket,
}));

vi.mock('../../../../../server/request-security', () => ({
  assertTrustedMutationOrigin: mocks.assertTrustedMutationOrigin,
}));

vi.mock('../../../../../server/video-space/shared-playback-card-quarantine', () => ({
  recordConfirmedSharedPlaybackDenial: mocks.recordConfirmedSharedPlaybackDenial,
}));

vi.mock('../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { EVaultVideoLibraryError } from '../../../../../server/evault-video-library';
import { setOperationalLogSinkForTests } from '../../../../../server/ops-observability';
import {
  mintSharedVideoAuthorizationReceipt,
  sharedVideoAuthorizationReceiptCookieName,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../server/shared-video-authorization-receipt';
import { createRecordingConcatTicket, POST } from './route';

const viewer = { eName: '@viewer.w3id' };
let operationalLogs: string[] = [];

describe('continuous recording ticket route', () => {
  beforeEach(() => {
    operationalLogs = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    mocks.assertTrustedMutationOrigin.mockReset();
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
    mocks.issueTicket.mockReset();
    mocks.recordConfirmedSharedPlaybackDenial.mockReset();
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
    mocks.issueTicket.mockReturnValue({
      ticket: 'opaque-ticket',
      playbackPath: '/api/evault/recordings/opaque-ticket',
    });
  });

  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
    vi.unstubAllEnvs();
  });

  it('completes source-zero authorization before returning the short playback path', async () => {
    const inspectBoundStream = vi.fn();
    let releaseWarmup: () => void = () => undefined;
    const warmup = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    const authorizePlayableStream = vi.fn(() => warmup);
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, authorizePlayableStream });

    const responsePromise = POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
    );

    await vi.waitFor(() => expect(authorizePlayableStream).toHaveBeenCalledTimes(1));
    // The ticket cannot expose a loopback ffmpeg path while its only required
    // shared-source authorization remains pending.
    expect(mocks.issueTicket).not.toHaveBeenCalled();
    releaseWarmup();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      playbackUrl: '/api/evault/recordings/opaque-ticket',
    });
    expect(mocks.assertTrustedMutationOrigin).toHaveBeenCalledTimes(1);
    expect(inspectBoundStream).toHaveBeenNthCalledWith(1, viewer, 'source-1');
    expect(inspectBoundStream).toHaveBeenCalledTimes(1);
    expect(mocks.issueTicket).toHaveBeenCalledWith(
      viewer,
      ['source-1', 'source-2'],
      undefined,
      expect.any(String),
    );
    expect(authorizePlayableStream).toHaveBeenCalledWith(viewer, 'source-1', {
      priority: 'interactive',
      allowExtendedLegacyFileMetadataWait: true,
      onTiming: expect.any(Function),
    });
    // Later segments are still kept opaque and untouched here.
    await warmup;
  });

  it('records only fixed, correlated ticket and warmup timing fields', async () => {
    const inspectBoundStream = vi.fn();
    const authorizePlayableStream = vi.fn(
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
        return Promise.resolve();
      },
    );
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, authorizePlayableStream });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['source-secret-1', 'source-secret-2'] }),
      }),
    );

    const correlationId = response.headers.get('x-request-id');
    expect(correlationId).toBeTruthy();
    await vi.waitFor(() => expect(operationalLogs).toHaveLength(2));
    const events = operationalLogs.map((line) => JSON.parse(line));
    const ticketTiming = events.find((event) => event.code === 'recording_ticket_timing');
    const warmupTiming = events.find((event) => event.code === 'recording_warmup_timing');
    expect(ticketTiming).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId,
      timing: {
        sessionValidationMs: expect.any(Number),
        firstSegmentValidationMs: expect.any(Number),
        ticketIssuedMs: expect.any(Number),
        requestReadyMs: expect.any(Number),
        warmupLaunched: true,
      },
    });
    expect(warmupTiming).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId,
      timing: {
        warmupCompletedMs: expect.any(Number),
        succeeded: true,
        mediaUrlCacheHit: false,
        sharedAccessVerificationMs: 5,
        eVaultResolutionMs: 11,
        directFileDereferenceMs: 7,
        platformTokenMs: 3,
        metadataReadMs: 0,
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('source-secret');
    expect(serialized).not.toContain('@viewer.w3id');
    expect(serialized).not.toContain('access-token');
  });

  it('keeps repeated cumulative authorization timing snapshots from inflating a failure trace', async () => {
    const inspectBoundStream = vi.fn();
    const authorizePlayableStream = vi.fn(
      (
        _user: unknown,
        _streamId: unknown,
        options?: { onTiming?: (timing: Record<string, unknown>) => void },
      ) => {
        const snapshot = {
          mediaUrlCacheHit: false,
          sharedAccessVerificationMs: 4_733,
          eVaultResolutionMs: 0,
          directFileDereferenceMs: 0,
          platformTokenMs: 0,
          metadataReadMs: 0,
        };
        // This models nested route/resolver failure observers receiving the
        // same cumulative timing object for one failed source-zero attempt.
        options?.onTiming?.(snapshot);
        options?.onTiming?.(snapshot);
        return Promise.reject(
          new EVaultVideoLibraryError('source unavailable', 'remote_unavailable', 503),
        );
      },
    );
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, authorizePlayableStream });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
    );

    expect(response.status).toBe(503);
    await vi.waitFor(() => expect(operationalLogs).toHaveLength(1));
    const event = JSON.parse(operationalLogs[0] ?? '{}');
    expect(event).toMatchObject({
      code: 'recording_warmup_timing',
      timing: {
        succeeded: false,
        warmupCompletedMs: expect.any(Number),
        sharedAccessVerificationMs: 4_733,
      },
    });
  });

  it('mints a fresh source-zero receipt for a ticket after completing authorization', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', '12345678901234567890123456789012');
    const inspectBoundStream = vi.fn();
    const authorizePlayableStream = vi.fn().mockResolvedValue('https://private.example/source-1');
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, authorizePlayableStream });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
    );

    expect(response.status).toBe(200);
    const options = mocks.issueTicket.mock.calls[0]?.[5] as
      | { initialAuthorizationReceipt?: unknown }
      | undefined;
    expect(options?.initialAuthorizationReceipt).toEqual(expect.any(String));
    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt: options?.initialAuthorizationReceipt as string,
        viewerEName: viewer.eName,
        streamId: 'source-1',
      }),
    ).toBe(true);
    expect(authorizePlayableStream).toHaveBeenCalledWith(viewer, 'source-1', {
      priority: 'interactive',
      allowExtendedLegacyFileMetadataWait: true,
      onTiming: expect.any(Function),
    });
  });

  it('reuses a verified source-zero receipt in the encrypted ticket without reopening it', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', '12345678901234567890123456789012');
    const initialAuthorizationReceipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'source-1',
    });
    const inspectBoundStream = vi.fn();
    const authorizePlayableStream = vi.fn().mockResolvedValue('https://private.example/source-1');
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, authorizePlayableStream });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${initialAuthorizationReceipt}`,
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.issueTicket).toHaveBeenCalledWith(
      viewer,
      ['source-1', 'source-2'],
      undefined,
      expect.any(String),
      undefined,
      { initialAuthorizationReceipt },
    );
    expect(authorizePlayableStream).not.toHaveBeenCalled();
  });

  it('accepts a verified Path-isolated first-source receipt for a continuous recording', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', '12345678901234567890123456789012');
    const initialAuthorizationReceipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'source-1',
    });
    const inspectBoundStream = vi.fn();
    const authorizePlayableStream = vi.fn().mockResolvedValue('https://private.example/source-1');
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, authorizePlayableStream });

    const response = await createRecordingConcatTicket(
      new NextRequest('https://vidak.example/api/evault/videos/source-1/recording-ticket', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
      {
        initialAuthorizationReceipt,
        expectedFirstStreamId: 'source-1',
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.issueTicket).toHaveBeenCalledWith(
      viewer,
      ['source-1', 'source-2'],
      undefined,
      expect.any(String),
      undefined,
      { initialAuthorizationReceipt },
    );
    expect(authorizePlayableStream).not.toHaveBeenCalled();
  });

  it('re-authorizes and rebinds a receipt when source zero has been renewed', async () => {
    vi.stubEnv('W3DS_AUTH_JWT_SECRET', '12345678901234567890123456789012');
    const oldReceipt = mintSharedVideoAuthorizationReceipt({
      viewerEName: viewer.eName,
      streamId: 'source-1',
    });
    const inspectBoundStream = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new EVaultVideoLibraryError('The stream expired.', 'stream_expired', 401);
      })
      .mockImplementation(() => undefined);
    const renewPlayableStream = vi.fn().mockResolvedValue('source-renewed');
    const authorizePlayableStream = vi.fn().mockResolvedValue('https://private.example/renewed');
    mocks.createLibrary.mockReturnValue({
      inspectBoundStream,
      renewPlayableStream,
      authorizePlayableStream,
    });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
          cookie: `${sharedVideoAuthorizationReceiptCookieName}=${oldReceipt}`,
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(renewPlayableStream).toHaveBeenCalledWith(viewer, 'source-1');
    expect(authorizePlayableStream).toHaveBeenCalledWith(viewer, 'source-renewed', {
      priority: 'interactive',
      allowExtendedLegacyFileMetadataWait: true,
      onTiming: expect.any(Function),
    });
    const args = mocks.issueTicket.mock.calls[0] as unknown[];
    expect(args.slice(0, 2)).toEqual([viewer, ['source-renewed', 'source-2']]);
    const options = args[5] as { initialAuthorizationReceipt?: string } | undefined;
    expect(options?.initialAuthorizationReceipt).not.toBe(oldReceipt);
    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt: options?.initialAuthorizationReceipt,
        viewerEName: viewer.eName,
        streamId: 'source-renewed',
      }),
    ).toBe(true);
  });

  it('does not issue a broken ticket when source-zero authorization rejects', async () => {
    const inspectBoundStream = vi.fn();
    const authorizePlayableStream = vi
      .fn()
      .mockRejectedValue(
        new EVaultVideoLibraryError(
          'This shared source is temporarily unavailable. Please try again.',
          'remote_unavailable',
          503,
        ),
      );
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, authorizePlayableStream });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'remote_unavailable',
        message: 'This shared source is temporarily unavailable. Please try again.',
      },
    });
    expect(authorizePlayableStream).toHaveBeenCalledTimes(1);
    expect(mocks.issueTicket).not.toHaveBeenCalled();
  });

  it('quarantines a card only after ticket authorization returns a terminal shared denial', async () => {
    const terminalDenial = new EVaultVideoLibraryError(
      'This shared source is no longer available.',
      'authorization_denied',
      403,
      undefined,
      'a'.repeat(43),
    );
    const inspectBoundStream = vi.fn();
    const authorizePlayableStream = vi.fn().mockRejectedValue(terminalDenial);
    mocks.createLibrary.mockReturnValue({ inspectBoundStream, authorizePlayableStream });

    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'authorization_denied' },
    });
    expect(mocks.issueTicket).not.toHaveBeenCalled();
    expect(mocks.recordConfirmedSharedPlaybackDenial).toHaveBeenCalledWith(terminalDenial);
  });

  it('rejects an oversized declared payload before parsing it', async () => {
    const response = await POST(
      new NextRequest('https://vidak.example/api/evault/recordings/tickets', {
        method: 'POST',
        headers: {
          authorization: 'Bearer access-token',
          'content-length': String(1_536 * 1024 + 1),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ streamIds: ['source-1', 'source-2'] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.createLibrary).not.toHaveBeenCalled();
  });
});
