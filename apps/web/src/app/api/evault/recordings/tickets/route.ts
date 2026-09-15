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
  mintSharedVideoAuthorizationReceipt,
  SharedVideoAuthorizationReceiptConfigurationError,
  sharedVideoAuthorizationReceiptCookieName,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../server/shared-video-authorization-receipt';
import { recordConfirmedSharedPlaybackDenial } from '../../../../../server/video-space/shared-playback-card-quarantine';
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
 * request establishes a valid authorization for only the first source before
 * issuing the ticket. Later grants remain opaque until ffmpeg reaches their
 * segment, so a long recording stays continuous without spending its opening
 * path decrypting every future chunk. Completing source zero first (or
 * reusing its already-valid receipt) prevents the ticket, ffmpeg, and a
 * browser warmup from racing the same shared-access proof.
 */
/**
 * Shared implementation for the legacy /recordings/tickets endpoint and the
 * stream-scoped endpoint used by the current player. The latter can receive
 * only the first video's Path-isolated authorization receipt, so warming a
 * different card never makes a continuous recording lose its source-zero
 * handoff.
 */
export async function createRecordingConcatTicket(
  request: NextRequest,
  options?: { initialAuthorizationReceipt?: string; expectedFirstStreamId?: string },
) {
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
    if (options?.expectedFirstStreamId && firstStreamId !== options.expectedFirstStreamId) {
      throw new RecordingConcatTicketError(
        'This recording does not match the requested first source.',
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
      options?.initialAuthorizationReceipt,
    );
    // A continuous player cannot recover if the ticket races segment zero's
    // initial shared-source proof: ffmpeg may receive its first loopback URL
    // before a concurrently launched warmup has established the proof. Reuse
    // a valid completed receipt, otherwise do the one required authorization
    // before returning an opaque ticket. Its media URL remains in the
    // server-only resolver cache; only a short signed hint is placed in the
    // encrypted ticket for a segment request on another replica.
    const ticketAuthorizationReceipt =
      initialAuthorizationReceipt ??
      (await authorizeFirstSegmentBeforeTicket(
        library,
        session.user,
        validFirstStreamId,
        correlationId,
      ));
    const ticketIssuedStartedAt = performance.now();
    const ticketStreamIds = [validFirstStreamId, ...streamIds.slice(1)];
    const { playbackPath } = ticketAuthorizationReceipt
      ? await issueRecordingConcatTicket(
          session.user,
          ticketStreamIds,
          undefined,
          correlationId,
          undefined,
          { initialAuthorizationReceipt: ticketAuthorizationReceipt },
        )
      : await issueRecordingConcatTicket(session.user, ticketStreamIds, undefined, correlationId);
    ticketIssuedMs = elapsedMs(ticketIssuedStartedAt);
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
    // Watch may now mount from its already viewer-bound card instead of
    // waiting for a duplicate catalogue lookup. Preserve the same durable
    // stale-card suppression as every other interactive media route, but only
    // for the library's typed terminal live-proof marker.
    recordConfirmedSharedPlaybackDenial(error);
    return errorResponse(error, correlationId);
  }
}

export async function POST(request: NextRequest) {
  return createRecordingConcatTicket(request);
}

/**
 * Completes source-zero authorization before an opaque recording ticket can
 * be returned. The resolver's private media URL stays server-only; the ticket
 * receives only a fresh viewer-and-stream-bound receipt so segment zero can
 * reuse this completed proof across replicas without starting it again.
 */
async function authorizeFirstSegmentBeforeTicket(
  library: ReturnType<typeof createEVaultVideoLibrary>,
  user: Parameters<ReturnType<typeof createEVaultVideoLibrary>['authorizePlayableStream']>[0],
  streamId: string,
  correlationId: string,
): Promise<string | undefined> {
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
      // Observability must not alter an authorization result.
    }
  };
  try {
    await library.authorizePlayableStream(user, streamId, {
      priority: 'interactive',
      // A source-zero ticket is a confirmed Watch action. When a legacy
      // eVault exposes the File only through GraphQL metadata, retain the
      // normal bounded source deadline instead of failing at the shorter
      // generic interactive compatibility cutoff. The catalogue warmer makes
      // this path exceptional rather than routine.
      allowExtendedLegacyFileMetadataWait: true,
      onTiming: recordTiming,
    });
    report(true);
  } catch (error) {
    report(false);
    throw error;
  }

  // A receipt is an optimization, not a grant. A configuration-less local
  // environment can still keep the already authorized result on this replica;
  // production receives the signed, portable handoff below.
  try {
    const receipt = mintSharedVideoAuthorizationReceipt({ viewerEName: user.eName, streamId });
    return verifySharedVideoAuthorizationReceipt({ receipt, viewerEName: user.eName, streamId })
      ? receipt
      : undefined;
  } catch (error) {
    if (error instanceof SharedVideoAuthorizationReceiptConfigurationError) {
      return undefined;
    }
    throw error;
  }
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
  receiptOverride?: string,
): string | undefined {
  const receipt =
    receiptOverride ?? request.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value;
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
  // `onTiming` reports a cumulative snapshot for one authorization attempt.
  // Nested failure boundaries may observe that same object more than once;
  // adding snapshots turns a five-second source proof into misleading ten- or
  // fifteen-second telemetry. Keep the furthest completed phase instead.
  return {
    mediaUrlCacheHit: current.mediaUrlCacheHit || next.mediaUrlCacheHit,
    sharedAccessVerificationMs: Math.max(
      current.sharedAccessVerificationMs,
      next.sharedAccessVerificationMs,
    ),
    eVaultResolutionMs: Math.max(current.eVaultResolutionMs, next.eVaultResolutionMs),
    directFileDereferenceMs: Math.max(
      current.directFileDereferenceMs,
      next.directFileDereferenceMs,
    ),
    platformTokenMs: Math.max(current.platformTokenMs, next.platformTokenMs),
    metadataReadMs: Math.max(current.metadataReadMs, next.metadataReadMs),
  };
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}
