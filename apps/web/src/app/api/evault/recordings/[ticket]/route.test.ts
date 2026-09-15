import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  cancelTicket: vi.fn(),
  claimTicket: vi.fn(),
  concatenate: vi.fn(),
  getAuthService: vi.fn(),
}));

vi.mock('../../../../../server/recording-concat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/recording-concat')>()),
  concatenateRecordingSources: mocks.concatenate,
}));

vi.mock('../../../../../server/recording-concat-ticket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/recording-concat-ticket')>()),
  cancelUnclaimedRecordingConcatTicket: mocks.cancelTicket,
  claimRecordingConcatTicket: mocks.claimTicket,
}));

vi.mock('../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { setOperationalLogSinkForTests } from '../../../../../server/ops-observability';
import { RecordingConcatError } from '../../../../../server/recording-concat';
import {
  RecordingConcatTicketError,
  recordingConcatTicketLeaseHeartbeatMs,
} from '../../../../../server/recording-concat-ticket';
import { DELETE, GET } from './route';

const viewer = { eName: '@viewer.w3id' };
let operationalLogs: string[] = [];

describe('recording ticket playback route', () => {
  beforeEach(() => {
    operationalLogs = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    mocks.cancelTicket.mockReset();
    mocks.claimTicket.mockReset();
    mocks.concatenate.mockReset();
    mocks.getAuthService.mockReset();
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
  });

  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
  });

  it('claims the viewer-bound ticket and streams only loopback segment paths', async () => {
    const release = vi.fn();
    const sourceUrls = [
      'http://127.0.0.1:3910/api/evault/recordings/ticket/segments/0?key=hidden',
      'http://127.0.0.1:3910/api/evault/recordings/ticket/segments/1?key=hidden',
    ];
    mocks.claimTicket.mockReturnValue({
      sourceUrls,
      correlationId: 'recording-correlation-1',
      renewLease: vi.fn().mockResolvedValue(true),
      release,
    });
    let onCompletion:
      | ((completion: {
          outcome: 'completed' | 'cancelled' | 'failed';
          bytesProduced: number;
        }) => void)
      | undefined;
    mocks.concatenate.mockImplementation(
      async (
        _sources: string[],
        options: {
          onCompletion?: (completion: {
            outcome: 'completed' | 'cancelled' | 'failed';
            bytesProduced: number;
          }) => void;
        },
      ) => {
        onCompletion = options.onCompletion;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('joined-mp4'));
            controller.close();
          },
        });
      },
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/recordings/opaque-ticket', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ ticket: 'opaque-ticket' }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('accept-ranges')).toBeNull();
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-request-id')).toBe('recording-correlation-1');
    expect(mocks.claimTicket).toHaveBeenCalledWith('opaque-ticket', viewer);
    expect(mocks.concatenate).toHaveBeenCalledWith(
      sourceUrls,
      expect.objectContaining({
        onClose: expect.any(Function),
        onCompletion: expect.any(Function),
      }),
    );
    expect(release).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe('joined-mp4');
    onCompletion?.({ outcome: 'cancelled', bytesProduced: 256 });
    const events = operationalLogs.map((line) => JSON.parse(line));
    const responseReady = events.find(
      (event) => event.code === 'recording_ffmpeg_response_ready_timing',
    );
    const firstByte = events.find((event) => event.code === 'recording_ffmpeg_first_byte_timing');
    expect(responseReady).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'recording-correlation-1',
      timing: {
        sessionValidationMs: expect.any(Number),
        ticketClaimMs: expect.any(Number),
        ffmpegStartupMs: expect.any(Number),
        responseReadyMs: expect.any(Number),
      },
    });
    expect(firstByte).toMatchObject({
      level: 'info',
      category: 'video_playback',
      correlationId: 'recording-correlation-1',
      timing: { requestFirstByteMs: expect.any(Number) },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        level: 'info',
        category: 'video_playback',
        correlationId: 'recording-correlation-1',
        code: 'recording_ffmpeg_completion_timing',
        timing: expect.objectContaining({ outcome: 'cancelled', bytesProduced: 256 }),
      }),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('opaque-ticket');
    expect(serialized).not.toContain('key=hidden');
    expect(serialized).not.toContain('@viewer.w3id');
  });

  it('cancels only by authenticated viewer while hiding the ticket state', async () => {
    mocks.cancelTicket.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const first = await DELETE(
      new NextRequest('https://vidak.example/api/evault/recordings/opaque-ticket', {
        method: 'DELETE',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ ticket: 'opaque-ticket' }) },
    );
    const second = await DELETE(
      new NextRequest('https://vidak.example/api/evault/recordings/opaque-ticket', {
        method: 'DELETE',
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ ticket: 'opaque-ticket' }) },
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(first.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');
    expect(mocks.cancelTicket).toHaveBeenNthCalledWith(1, 'opaque-ticket', viewer);
    expect(mocks.cancelTicket).toHaveBeenNthCalledWith(2, 'opaque-ticket', viewer);
  });

  it('rejects an unauthenticated preload cancellation before it reaches ticket storage', async () => {
    const response = await DELETE(
      new NextRequest('https://vidak.example/api/evault/recordings/opaque-ticket', {
        method: 'DELETE',
        headers: { origin: 'https://vidak.example' },
      }),
      { params: Promise.resolve({ ticket: 'opaque-ticket' }) },
    );

    expect(response.status).toBe(401);
    expect(mocks.cancelTicket).not.toHaveBeenCalled();
  });

  it('releases a claimed ticket when setup fails before the stream is returned', async () => {
    const release = vi.fn();
    mocks.claimTicket.mockReturnValue({
      sourceUrls: ['http://127.0.0.1:3910/a', 'http://127.0.0.1:3910/b'],
      correlationId: 'recording-correlation-2',
      renewLease: vi.fn().mockResolvedValue(true),
      release,
    });
    mocks.concatenate.mockRejectedValue(new Error('ffmpeg unavailable'));

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/recordings/opaque-ticket', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ ticket: 'opaque-ticket' }) },
    );

    expect(response.status).toBe(500);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('records a source-safe signal when a native retry finds a ticket already claimed', async () => {
    mocks.claimTicket.mockRejectedValue(
      new RecordingConcatTicketError(
        'This recording is already opening. Please retry playback.',
        'busy',
        409,
      ),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/recordings/opaque-ticket', {
        headers: { authorization: 'Bearer access-token', range: 'bytes=0-' },
      }),
      { params: Promise.resolve({ ticket: 'opaque-ticket' }) },
    );

    expect(response.status).toBe(409);
    const events = operationalLogs.map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        level: 'info',
        category: 'video_playback',
        code: 'recording_ticket_claim_busy_range',
      }),
    );
    expect(JSON.stringify(events)).not.toContain('opaque-ticket');
    expect(JSON.stringify(events)).not.toContain('bytes=0-');
  });

  it('renews the active lease only while its ffmpeg route remains live', async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const renewLease = vi.fn().mockResolvedValue(true);
    let onClose: (() => void | Promise<void>) | undefined;
    mocks.claimTicket.mockReturnValue({
      sourceUrls: ['http://127.0.0.1:3910/a', 'http://127.0.0.1:3910/b'],
      correlationId: 'recording-correlation-lease',
      renewLease,
      release,
    });
    mocks.concatenate.mockImplementation(
      async (_sources: string[], options: { onClose?: () => void | Promise<void> }) => {
        onClose = options.onClose;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('joined-mp4'));
          },
        });
      },
    );

    try {
      const response = await GET(
        new NextRequest('https://vidak.example/api/evault/recordings/opaque-ticket', {
          headers: { authorization: 'Bearer access-token' },
        }),
        { params: Promise.resolve({ ticket: 'opaque-ticket' }) },
      );

      expect(response.status).toBe(200);
      await vi.advanceTimersByTimeAsync(recordingConcatTicketLeaseHeartbeatMs);
      expect(renewLease).toHaveBeenCalledTimes(1);

      await onClose?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(recordingConcatTicketLeaseHeartbeatMs * 2);
      expect(renewLease).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a sanitized 503 and redacted timing when ffmpeg has no startup byte', async () => {
    const release = vi.fn();
    const sourceUrls = [
      'http://127.0.0.1:3910/api/evault/recordings/ticket/segments/0?key=hidden',
      'http://127.0.0.1:3910/api/evault/recordings/ticket/segments/1?key=hidden',
    ];
    mocks.claimTicket.mockReturnValue({
      sourceUrls,
      correlationId: 'recording-correlation-startup-timeout',
      renewLease: vi.fn().mockResolvedValue(true),
      release,
    });
    mocks.concatenate.mockRejectedValue(
      new RecordingConcatError(
        'This recording could not start. Please retry.',
        'recording_unavailable',
        503,
        'startup_timeout',
      ),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/recordings/opaque-ticket', {
        headers: { authorization: 'Bearer access-token' },
      }),
      { params: Promise.resolve({ ticket: 'opaque-ticket' }) },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('recording-correlation-startup-timeout');
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'recording_unavailable',
        message: 'This recording could not start. Please retry.',
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
    const events = operationalLogs.map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          category: 'video_playback',
          correlationId: 'recording-correlation-startup-timeout',
          code: 'recording_unavailable',
          message: 'Continuous recording startup failed.',
        }),
        expect.objectContaining({
          level: 'info',
          category: 'video_playback',
          correlationId: 'recording-correlation-startup-timeout',
          code: 'recording_ffmpeg_startup_failed_timing',
          timing: {
            failureKind: 'startup_timeout',
            sessionValidationMs: expect.any(Number),
            ticketClaimMs: expect.any(Number),
            ffmpegStartupMs: expect.any(Number),
            requestFailedMs: expect.any(Number),
          },
        }),
      ]),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('opaque-ticket');
    expect(serialized).not.toContain('key=hidden');
    expect(serialized).not.toContain('@viewer.w3id');
  });
});
