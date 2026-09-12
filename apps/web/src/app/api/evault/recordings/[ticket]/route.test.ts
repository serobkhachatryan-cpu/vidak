import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
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
  claimRecordingConcatTicket: mocks.claimTicket,
}));

vi.mock('../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { setOperationalLogSinkForTests } from '../../../../../server/ops-observability';
import { RecordingConcatError } from '../../../../../server/recording-concat';
import { recordingConcatTicketLeaseHeartbeatMs } from '../../../../../server/recording-concat-ticket';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };
let operationalLogs: string[] = [];

describe('recording ticket playback route', () => {
  beforeEach(() => {
    operationalLogs = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
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
    mocks.concatenate.mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('joined-mp4'));
          controller.close();
        },
      }),
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
    expect(mocks.concatenate).toHaveBeenCalledWith(sourceUrls, {
      onClose: expect.any(Function),
    });
    expect(release).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe('joined-mp4');
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
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('opaque-ticket');
    expect(serialized).not.toContain('key=hidden');
    expect(serialized).not.toContain('@viewer.w3id');
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
