import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
  type MediaAuthorizationTimingContext,
  type MediaResolutionTiming,
} from '../../../../../../server/evault-video-library';
import {
  reportVideoAuthorizationTiming,
  resolveCorrelationId,
  type VideoAuthorizationFailureKind,
  type VideoAuthorizationTimingMode,
} from '../../../../../../server/ops-observability';
import { putPlaybackResolutionCache } from '../../../../../../server/playback-resolution-cache';
import {
  mintSharedVideoAuthorizationReceipt,
  SharedVideoAuthorizationReceiptConfigurationError,
  sharedVideoAuthorizationReceiptCookieName,
  sharedVideoAuthorizationReceiptCookieOptions,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../../server/shared-video-authorization-receipt';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

/**
 * Resolves the viewer-bound private media authorization after an explicit
 * Watch intent. It never downloads media bytes; the player itself streams
 * promptly and uses the short-lived read-through RAM cache as bytes arrive.
 *
 * Older cards can still send a background request while their client bundle
 * is being replaced. Those requests validate only the local stream binding,
 * so a large grid cannot create a burst of competing remote eVault reads.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ streamId: string }> },
) {
  const correlationId = resolveCorrelationId(request.headers);
  const requestStartedAt = performance.now();
  const mode = authorizationTimingMode(request.nextUrl.searchParams.get('priority'));
  let sessionValidationMs = 0;
  let authorizationResolutionMs = 0;
  let mediaResolutionTiming: MediaResolutionTiming | undefined;
  let authorizationContext: MediaAuthorizationTimingContext | undefined;
  const recordMediaResolutionTiming = (timing: MediaResolutionTiming): void => {
    mediaResolutionTiming = mergeMediaResolutionTiming(mediaResolutionTiming, timing);
  };
  const recordAuthorizationContext = (next: MediaAuthorizationTimingContext): void => {
    authorizationContext = next;
  };
  const reportTiming = (succeeded: boolean, error?: unknown): void => {
    try {
      const timing = mediaResolutionTiming ?? emptyMediaResolutionTiming();
      reportVideoAuthorizationTiming({
        correlationId,
        mode,
        succeeded,
        ...(succeeded ? {} : { failureKind: authorizationFailureKind(error) }),
        ...authorizationContext,
        sessionValidationMs,
        authorizationResolutionMs,
        ...timing,
        requestCompletedMs: elapsedMs(requestStartedAt),
      });
    } catch {
      // Structured logging must never affect the viewer's authorization or
      // expose a route failure as a playback failure.
    }
  };
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const sessionValidationStartedAt = performance.now();
    const session = await getW3dsAuthService().getSession(accessToken);
    sessionValidationMs = elapsedMs(sessionValidationStartedAt);
    const { streamId } = await context.params;
    const library = createEVaultVideoLibrary();
    const authorizationStartedAt = performance.now();
    let resolvedMediaUrl: string | undefined;
    try {
      if (mode === 'background') {
        library.inspectBoundStream(session.user, streamId);
      } else if (mode === 'warmup') {
        // A hover is cancellable speculative work. Keep its pending source
        // resolution isolated from the real player, then stop it as soon as the
        // viewer leaves the card.
        resolvedMediaUrl = await library.authorizePlayableStream(session.user, streamId, {
          priority: 'warmup',
          signal: request.signal,
          onTiming: recordMediaResolutionTiming,
          onAuthorizationContext: recordAuthorizationContext,
        });
      } else {
        // An explicit Watch warmup shares the player's interactive pending key
        // and intentionally outlives the client-side route transition.
        resolvedMediaUrl = await library.authorizePlayableStream(session.user, streamId, {
          priority: 'interactive',
          onTiming: recordMediaResolutionTiming,
          onAuthorizationContext: recordAuthorizationContext,
        });
      }
    } finally {
      authorizationResolutionMs = elapsedMs(authorizationStartedAt);
    }
    const response = new NextResponse(null, {
      status: 204,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    // A background card inspection does not establish source authorization.
    // Successful interactive and hover warmups get a short opaque receipt so
    // a player request routed to another replica can reuse this exact work.
    if (mode !== 'background') {
      try {
        const receipt = mintSharedVideoAuthorizationReceipt({
          viewerEName: session.user.eName,
          streamId,
        });
        // Keep the cross-replica handoff strictly subordinate to the receipt:
        // the opaque value is verified before it is written or used as a cache
        // key, and the private URL remains server-only throughout.
        if (
          verifySharedVideoAuthorizationReceipt({
            receipt,
            viewerEName: session.user.eName,
            streamId,
          })
        ) {
          response.cookies.set(
            sharedVideoAuthorizationReceiptCookieName,
            receipt,
            sharedVideoAuthorizationReceiptCookieOptions(),
          );
          if (typeof resolvedMediaUrl === 'string') {
            // The browser can use this receipt immediately on another replica
            // to skip the completed shared-source proof. Persisting the
            // encrypted URL is an optional extra optimization, so it must not
            // hold the 204 (and therefore the Set-Cookie) behind a slow or
            // unavailable database. The helper observes every failure without
            // logging a private media URL.
            startReceiptBoundResolutionCacheWrite({
              receipt,
              viewerEName: session.user.eName,
              streamId,
              mediaUrl: resolvedMediaUrl,
            });
          }
        }
      } catch (error) {
        // A dev/test setup can exercise the authorization route with a mock
        // library but without W3DS_AUTH_JWT_SECRET. The receipt is only an
        // optimization, so preserve the successful warmup in that case.
        if (!(error instanceof SharedVideoAuthorizationReceiptConfigurationError)) throw error;
      }
    }
    reportTiming(true);
    return response;
  } catch (error) {
    reportTiming(false, error);
    return errorResponse(error);
  }
}

/**
 * The encrypted resolution cache is best-effort after authorization has
 * succeeded. Do not await this promise from the HTTP handler: a pending
 * database transaction must never delay delivery of the verified receipt to
 * the player. The normal media route retains its full authorized resolution
 * fallback if this write never completes.
 */
function startReceiptBoundResolutionCacheWrite(input: {
  receipt: string;
  viewerEName: string;
  streamId: string;
  mediaUrl: string;
}): void {
  try {
    void Promise.resolve(putPlaybackResolutionCache(input)).catch(() => undefined);
  } catch {
    // Keep a synchronous mock/configuration fault as opaque as a rejected
    // asynchronous write. In either case the receipt is still valid.
  }
}

function authorizationTimingMode(priority: string | null): VideoAuthorizationTimingMode {
  if (priority === 'background') return 'background';
  if (priority === 'warmup') return 'warmup';
  return 'interactive';
}

function authorizationFailureKind(error: unknown): VideoAuthorizationFailureKind {
  if (error instanceof W3dsAuthError) return 'authentication';
  if (!(error instanceof EVaultVideoLibraryError)) return 'internal';
  if (error.code === 'authentication_required') return 'authentication';
  if (error.code === 'authorization_denied') return 'authorization';
  if (error.code === 'invalid_stream' || error.code === 'stream_expired') return 'stream';
  return 'source_unavailable';
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

function errorResponse(error: unknown): NextResponse {
  const known = error instanceof EVaultVideoLibraryError || error instanceof W3dsAuthError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'internal_error';
  const message = known ? error.message : 'Video authorization is unavailable.';
  return NextResponse.json(
    { error: { code, message } },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
