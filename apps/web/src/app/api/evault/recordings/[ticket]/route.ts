import { type NextRequest, NextResponse } from 'next/server';
import {
  CORRELATION_HEADER,
  reportOperationalFailure,
  reportRecordingFfmpegStartupFailureTiming,
  reportRecordingFfmpegTiming,
} from '../../../../../server/ops-observability';
import {
  concatenateRecordingSources,
  RecordingConcatError,
} from '../../../../../server/recording-concat';
import {
  claimRecordingConcatTicket,
  RecordingConcatTicketError,
  recordingConcatTicketLeaseHeartbeatMs,
} from '../../../../../server/recording-concat-ticket';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

/**
 * Browser-visible continuous recording stream. The opaque ticket is bound to
 * this exact signed-in viewer; individual sealed grants and source URLs stay
 * server-only in the RAM ticket and ffmpeg manifest.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ ticket: string }> }) {
  const requestStartedAt = performance.now();
  let release: (() => Promise<void>) | undefined;
  let stopLeaseHeartbeat: (() => void) | undefined;
  let correlationId: string | undefined;
  let sessionValidationMs = 0;
  let ticketClaimMs = 0;
  let ffmpegStartupStartedAt: number | undefined;
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const sessionValidationStartedAt = performance.now();
    const session = await getW3dsAuthService().getSession(accessToken);
    sessionValidationMs = elapsedMs(sessionValidationStartedAt);
    const { ticket } = await context.params;
    const ticketClaimStartedAt = performance.now();
    const claimed = await claimRecordingConcatTicket(ticket, session.user);
    ticketClaimMs = elapsedMs(ticketClaimStartedAt);
    correlationId = claimed.correlationId;
    // Startup failures can race the child close handler and the route catch.
    // Make ticket release idempotent so either path is safe without retaining
    // a claimed ticket or calling its cleanup more than once.
    const releaseOnce = once(async () => {
      stopLeaseHeartbeat?.();
      await claimed.release();
    });
    release = releaseOnce;
    // A claimed ticket has an eight-hour playback lifetime, but consumes an
    // admission slot only while this live ffmpeg-owning route renews its short
    // lease. A pod crash stops the interval, so the slot self-recovers soon.
    stopLeaseHeartbeat = startTicketLeaseHeartbeat(claimed.renewLease);
    ffmpegStartupStartedAt = performance.now();
    // The concat helper resolves only after it has a non-empty ffmpeg chunk.
    // Therefore returning this response means the browser has a real media
    // stream, not merely a process that may never produce one.
    const body = await concatenateRecordingSources(claimed.sourceUrls, {
      onClose: () => {
        void releaseOnce().catch(() => undefined);
      },
    });
    const ffmpegStartupMs = elapsedMs(ffmpegStartupStartedAt);
    // `onClose` owns the success path. Clear this local reference so a later
    // handler error cannot release a still-streaming concat process.
    release = undefined;
    const responseReadyMs = elapsedMs(requestStartedAt);
    safelyReportFfmpegTiming({
      correlationId: claimed.correlationId,
      phase: 'response_ready',
      sessionValidationMs,
      ticketClaimMs,
      ffmpegStartupMs,
      responseReadyMs,
    });
    const observedBody = observeFirstFfmpegByte(body, () => {
      safelyReportFfmpegTiming({
        correlationId: claimed.correlationId,
        phase: 'first_byte',
        sessionValidationMs,
        ticketClaimMs,
        ffmpegStartupMs,
        responseReadyMs,
        requestFirstByteMs: elapsedMs(requestStartedAt),
      });
    });
    return new NextResponse(observedBody, {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Type': 'video/mp4',
        'Referrer-Policy': 'no-referrer',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
        [CORRELATION_HEADER]: claimed.correlationId,
      },
    });
  } catch (error) {
    await release?.().catch(() => undefined);
    reportStartupFailure(error, {
      correlationId,
      sessionValidationMs,
      ticketClaimMs,
      ffmpegStartupMs:
        ffmpegStartupStartedAt === undefined ? undefined : elapsedMs(ffmpegStartupStartedAt),
      requestFailedMs: elapsedMs(requestStartedAt),
    });
    return errorResponse(error, correlationId);
  }
}

/**
 * This observes only the first non-empty ffmpeg output chunk. It does not
 * buffer, inspect, alter, or retain media bytes, so it leaves stream
 * backpressure and cancellation behavior unchanged.
 */
function observeFirstFfmpegByte(
  body: ReadableStream<Uint8Array>,
  onFirstByte: () => void,
): ReadableStream<Uint8Array> {
  let firstByteObserved = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!firstByteObserved && chunk.byteLength > 0) {
          firstByteObserved = true;
          try {
            onFirstByte();
          } catch {
            // Observability must never interrupt an authenticated recording.
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function safelyReportFfmpegTiming(input: Parameters<typeof reportRecordingFfmpegTiming>[0]): void {
  try {
    reportRecordingFfmpegTiming(input);
  } catch {
    // Log aggregation must not affect authenticated media playback.
  }
}

function reportStartupFailure(
  error: unknown,
  input: {
    correlationId: string | undefined;
    sessionValidationMs: number;
    ticketClaimMs: number;
    ffmpegStartupMs: number | undefined;
    requestFailedMs: number;
  },
): void {
  if (
    !(error instanceof RecordingConcatError) ||
    !error.startupFailureKind ||
    !input.correlationId ||
    input.ffmpegStartupMs === undefined
  ) {
    return;
  }
  try {
    // Keep the operational error text fixed. FFmpeg's raw error output can
    // contain the private loopback segment capability and must never be sent
    // to log aggregation.
    reportOperationalFailure({
      category: 'video_playback',
      correlationId: input.correlationId,
      code: error.code,
      error: new Error('Continuous recording startup failed.'),
    });
    reportRecordingFfmpegStartupFailureTiming({
      correlationId: input.correlationId,
      failureKind: error.startupFailureKind,
      sessionValidationMs: input.sessionValidationMs,
      ticketClaimMs: input.ticketClaimMs,
      ffmpegStartupMs: input.ffmpegStartupMs,
      requestFailedMs: input.requestFailedMs,
    });
  } catch {
    // Observability must never replace the sanitized browser failure.
  }
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

function errorResponse(error: unknown, correlationId?: string): NextResponse {
  const known =
    error instanceof W3dsAuthError ||
    error instanceof RecordingConcatTicketError ||
    error instanceof RecordingConcatError;
  const status =
    error instanceof W3dsAuthError ||
    error instanceof RecordingConcatTicketError ||
    error instanceof RecordingConcatError
      ? error.status
      : 500;
  const code =
    error instanceof W3dsAuthError ||
    error instanceof RecordingConcatTicketError ||
    error instanceof RecordingConcatError
      ? error.code
      : 'recording_unavailable';
  const message = known ? error.message : 'This recording cannot be joined for playback.';
  const response = NextResponse.json(
    { error: { code, message } },
    { status: known ? status : 500 },
  );
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (correlationId) response.headers.set(CORRELATION_HEADER, correlationId);
  return response;
}

function once(callback: () => void | Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= Promise.resolve().then(callback);
    return result;
  };
}

function startTicketLeaseHeartbeat(renewLease: () => Promise<boolean>): () => void {
  let stopped = false;
  let renewing = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped || renewing) return;
    renewing = true;
    void renewLease()
      .then((renewed) => {
        // A released/expired ticket cannot safely be kept alive by an orphaned
        // timer. The ffmpeg process will close through its normal route path.
        if (!renewed) stop();
      })
      .catch(() => {
        // A transient DB outage must not tear down an otherwise healthy media
        // response. If the process actually dies, the lease still expires.
      })
      .finally(() => {
        renewing = false;
      });
  }, recordingConcatTicketLeaseHeartbeatMs);
  timer.unref?.();
  return stop;
}
