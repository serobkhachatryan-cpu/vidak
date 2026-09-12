import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
  type MediaResolutionTiming,
} from '../../../../../server/evault-video-library';
import {
  CORRELATION_HEADER,
  createCorrelationId,
  reportRecordingTicketTiming,
  reportRecordingWarmupTiming,
} from '../../../../../server/ops-observability';
import {
  issueRecordingConcatTicket,
  parseRecordingStreamIds,
  RecordingConcatTicketError,
} from '../../../../../server/recording-concat-ticket';
import { assertTrustedMutationOrigin } from '../../../../../server/request-security';
import {
  SharedVideoAuthorizationReceiptConfigurationError,
  sharedVideoAuthorizationReceiptCookieName,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../server/shared-video-authorization-receipt';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';
const maxTicketRequestBytes = 1_536 * 1_024;

/**
 * Keeps a long recording's sealed stream grants out of the browser URL. The
 * request validates only the first grant locally. Later grants remain opaque
 * until ffmpeg reaches their segment, so a long recording can start without
 * spending its opening path decrypting every future chunk. The first source
 * may start a viewer-bound authorization warmup only after its ticket exists;
 * that overlaps the browser navigation but never exposes a media URL or
 * opens any later segment.
 */
export async function POST(request: NextRequest) {
  // This is intentionally server-generated instead of copying arbitrary
  // caller input. It joins the ticket, loopback source, and ffmpeg timings
  // without placing any source identity in a response or log.
  const correlationId = createCorrelationId();
  const requestStartedAt = performance.now();
  let sessionValidationMs = 0;
  let firstSegmentValidationMs = 0;
  let ticketIssuedMs = 0;
  try {
    assertTrustedMutationOrigin(request);
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxTicketRequestBytes) {
      throw new RecordingConcatTicketError(
        'This recording has too many source references to open safely.',
        'invalid_recording',
        400,
      );
    }
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const sessionValidationStartedAt = performance.now();
    const session = await getW3dsAuthService().getSession(accessToken);
    sessionValidationMs = elapsedMs(sessionValidationStartedAt);
    const body = (await request.json().catch(() => undefined)) as
      | { streamIds?: unknown }
      | undefined;
    const streamIds = parseRecordingStreamIds(body?.streamIds);
    const library = createEVaultVideoLibrary();
    // Segment zero is the only source needed to start playback. Each later
    // grant is bounded and kept server-only in the ticket, then validated and
    // renewed lazily by the internal segment route as concat advances.
    const firstStreamId = streamIds[0];
    if (!firstStreamId) {
      throw new RecordingConcatTicketError(
        'This recording does not have a valid set of sources.',
        'invalid_recording',
        400,
      );
    }
    const firstSegmentValidationStartedAt = performance.now();
    const validFirstStreamId = await validateOrRenewStream(library, session.user, firstStreamId);
    firstSegmentValidationMs = elapsedMs(firstSegmentValidationStartedAt);
    const initialAuthorizationReceipt = verifiedInitialAuthorizationReceipt(
      request,
      session.user.eName,
      validFirstStreamId,
    );
    const ticketIssuedStartedAt = performance.now();
    const ticketStreamIds = [validFirstStreamId, ...streamIds.slice(1)];
    const { playbackPath } = initialAuthorizationReceipt
      ? await issueRecordingConcatTicket(
          session.user,
          ticketStreamIds,
          undefined,
          correlationId,
          undefined,
          { initialAuthorizationReceipt },
        )
      : await issueRecordingConcatTicket(session.user, ticketStreamIds, undefined, correlationId);
    ticketIssuedMs = elapsedMs(ticketIssuedStartedAt);
    // This is an explicit Watch action. Start only segment zero's existing
    // viewer-bound authorization path while the browser receives the opaque
    // ticket and starts ffmpeg. The segment route always repeats that check
    // before bytes stream, and a failure remains private and does not make
    // issuing the ticket fail.
    startFirstSegmentWarmup(
      library,
      session.user,
      validFirstStreamId,
      correlationId,
      Boolean(initialAuthorizationReceipt),
    );
    safelyReportTicketTiming({
      correlationId,
      sessionValidationMs,
      firstSegmentValidationMs,
      ticketIssuedMs,
      requestReadyMs: elapsedMs(requestStartedAt),
      warmupLaunched: true,
    });
    return privateJson({ playbackUrl: playbackPath }, 200, correlationId);
  } catch (error) {
    return errorResponse(error, correlationId);
  }
}

/**
 * Runs the existing segment-zero authorization warmup without adding it to
 * the ticket response path. Its timing callback is fixed-schema and has no
 * access to the media URL returned by the library.
 */
function startFirstSegmentWarmup(
  library: ReturnType<typeof createEVaultVideoLibrary>,
  user: Parameters<ReturnType<typeof createEVaultVideoLibrary>['authorizePlayableStream']>[0],
  streamId: string,
  correlationId: string,
  hasRecentSharedAuthorizationReceipt: boolean,
): void {
  const startedAt = performance.now();
  let timing: MediaResolutionTiming | undefined;
  const recordTiming = (next: MediaResolutionTiming): void => {
    timing = mergeMediaResolutionTiming(timing, next);
  };
  const report = (succeeded: boolean): void => {
    const observed = timing ?? emptyMediaResolutionTiming();
    try {
      reportRecordingWarmupTiming({
        correlationId,
        warmupCompletedMs: elapsedMs(startedAt),
        succeeded,
        ...observed,
      });
    } catch {
      // Observability must not turn a detached warmup into a rejection.
    }
  };
  void library
    .authorizePlayableStream(user, streamId, {
      priority: 'interactive',
      onTiming: recordTiming,
      ...(hasRecentSharedAuthorizationReceipt ? { hasRecentSharedAuthorizationReceipt: true } : {}),
    })
    .then(
      () => report(true),
      () => report(false),
    )
    .catch(() => undefined);
}

/**
 * The browser can send the opaque receipt only because the card's successful
 * authorization warmup set it. Verify it against this session and the first
 * sealed stream before it ever enters the encrypted ticket; a malformed,
 * expired, or unavailable dev receipt simply falls back to the ordinary
 * authoritative source check.
 */
function verifiedInitialAuthorizationReceipt(
  request: NextRequest,
  viewerEName: string,
  streamId: string,
): string | undefined {
  const receipt = request.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value;
  if (!receipt) return undefined;
  try {
    return verifySharedVideoAuthorizationReceipt({ receipt, viewerEName, streamId })
      ? receipt
      : undefined;
  } catch (error) {
    if (error instanceof SharedVideoAuthorizationReceiptConfigurationError) return undefined;
    throw error;
  }
}

async function validateOrRenewStream(
  library: ReturnType<typeof createEVaultVideoLibrary>,
  user: Parameters<ReturnType<typeof createEVaultVideoLibrary>['inspectBoundStream']>[0],
  streamId: string,
): Promise<string> {
  try {
    library.inspectBoundStream(user, streamId);
    return streamId;
  } catch (error) {
    if (!(error instanceof EVaultVideoLibraryError) || error.code !== 'stream_expired') throw error;
    const renewed = await library.renewPlayableStream(user, streamId);
    library.inspectBoundStream(user, renewed);
    return renewed;
  }
}

function errorResponse(error: unknown, correlationId: string): NextResponse {
  const known =
    error instanceof EVaultVideoLibraryError ||
    error instanceof W3dsAuthError ||
    error instanceof RecordingConcatTicketError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'internal_error';
  const message = known ? error.message : 'This recording cannot be opened.';
  return privateJson({ error: { code, message } }, status, correlationId);
}

function privateJson(body: unknown, status = 200, correlationId?: string): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  if (correlationId) response.headers.set(CORRELATION_HEADER, correlationId);
  return response;
}

function safelyReportTicketTiming(input: Parameters<typeof reportRecordingTicketTiming>[0]): void {
  try {
    reportRecordingTicketTiming(input);
  } catch {
    // A structured log sink must never affect the browser's ticket request.
  }
}

function emptyMediaResolutionTiming(): MediaResolutionTiming {
  return {
    mediaUrlCacheHit: false,
    sharedAccessVerificationMs: 0,
    eVaultResolutionMs: 0,
    directFileDereferenceMs: 0,
    platformTokenMs: 0,
    metadataReadMs: 0,
  };
}

function mergeMediaResolutionTiming(
  current: MediaResolutionTiming | undefined,
  next: MediaResolutionTiming,
): MediaResolutionTiming {
  if (!current) return next;
  return {
    mediaUrlCacheHit: current.mediaUrlCacheHit && next.mediaUrlCacheHit,
    sharedAccessVerificationMs:
      current.sharedAccessVerificationMs + next.sharedAccessVerificationMs,
    eVaultResolutionMs: current.eVaultResolutionMs + next.eVaultResolutionMs,
    directFileDereferenceMs: current.directFileDereferenceMs + next.directFileDereferenceMs,
    platformTokenMs: current.platformTokenMs + next.platformTokenMs,
    metadataReadMs: current.metadataReadMs + next.metadataReadMs,
  };
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}
