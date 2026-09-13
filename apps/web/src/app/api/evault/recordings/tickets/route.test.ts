import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  assertTrustedMutationOrigin: vi.fn(),
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
  issueTicket: vi.fn(),
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

vi.mock('../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { setOperationalLogSinkForTests } from '../../../../../server/ops-observability';
import {
  mintSharedVideoAuthorizationReceipt,
  sharedVideoAuthorizationReceiptCookieName,
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

  it('validates and starts only the first grant warmup before returning the short playback path', async () => {
    const inspectBoundStream = vi.fn();
    let releaseWarmup: () => void = () => undefined;
    const warmup = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    const authorizePlayableStream = vi.fn(() => warmup);
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
      onTiming: expect.any(Function),
    });
    // The client can start its GET / ffmpeg path without waiting for the
    // remote source warmup. Later segments are not touched here.
    releaseWarmup();
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

  it('carries a verified source-zero warmup receipt into the encrypted ticket only', async () => {
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
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'source-1',
      expect.objectContaining({
        priority: 'interactive',
        hasRecentSharedAuthorizationReceipt: true,
        onTiming: expect.any(Function),
      }),
    );
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
    expect(authorizePlayableStream).toHaveBeenCalledWith(
      viewer,
      'source-1',
      expect.objectContaining({ hasRecentSharedAuthorizationReceipt: true }),
    );
  });

  it('does not fail ticket issuance when the first-source warmup rejects', async () => {
    const inspectBoundStream = vi.fn();
    const authorizePlayableStream = vi.fn().mockRejectedValue(new Error('source unavailable'));
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
    expect(authorizePlayableStream).toHaveBeenCalledTimes(1);
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
