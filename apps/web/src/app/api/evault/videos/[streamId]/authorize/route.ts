import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
  type ForcedSourceRefreshProof,
  type MediaAuthorizationTimingContext,
  type MediaResolutionTiming,
} from '../../../../../../server/evault-video-library';
import {
  reportVideoAuthorizationTiming,
  resolveCorrelationId,
  type VideoAuthorizationFailureKind,
  type VideoAuthorizationTimingMode,
} from '../../../../../../server/ops-observability';
import {
  claimPlaybackSourceRefresh,
  type PlaybackSourceRefreshLease,
  publishPlaybackSourceRefresh,
  readPlaybackSourceRefresh,
  releasePlaybackSourceRefresh,
} from '../../../../../../server/playback-source-refresh';
import { resolvePrivateMediaUrlCacheExpiry } from '../../../../../../server/private-media-upstream';
import { assertTrustedMutationOrigin } from '../../../../../../server/request-security';
import {
  mintSharedVideoAuthorizationReceipt,
  SharedVideoAuthorizationReceiptConfigurationError,
  sharedVideoAuthorizationReceiptCookieName,
  sharedVideoAuthorizationReceiptCookieOptions,
  sharedVideoStreamAuthorizationReceiptCookieName,
  sharedVideoStreamAuthorizationReceiptCookieOptions,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../../server/shared-video-authorization-receipt';
import { recordConfirmedSharedPlaybackDenial } from '../../../../../../server/video-space/shared-playback-card-quarantine';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

// A recovery receipt must already have its fresh redirect in the durable
// cross-replica handoff before it is issued. Do not let an unhealthy database
// turn that safety fence into an indefinitely loading Retry playback button.
export const forcedSourceRefreshHandoffTimeoutMs = 5_000;

type AuthorizationRouteContext = { params: Promise<{ streamId: string }> };

/**
 * Resolves the viewer-bound private media authorization after an explicit
 * Watch intent. It never downloads media bytes; the player itself streams
 * promptly and uses the short-lived read-through RAM cache as bytes arrive.
 *
 * Older cards can still send a background request while their client bundle
 * is being replaced. Those requests validate only the local stream binding,
 * so a large grid cannot create a burst of competing remote eVault reads.
 */
export async function GET(request: NextRequest, context: AuthorizationRouteContext) {
  return authorize(request, context, {
    mode: authorizationTimingMode(request.nextUrl.searchParams.get('priority')),
    refreshSource: false,
  });
}

/**
 * The one explicit recovery operation. POST keeps cache eviction out of the
 * browser-addressable GET warmup path. Cookie-authenticated POSTs are guarded
 * by the project's trusted-Origin / Fetch-Metadata mutation boundary.
 */
export async function POST(request: NextRequest, context: AuthorizationRouteContext) {
  return authorize(request, context, { mode: 'interactive', refreshSource: true });
}

async function authorize(
  request: NextRequest,
  context: AuthorizationRouteContext,
  options: { mode: VideoAuthorizationTimingMode; refreshSource: boolean },
) {
  const correlationId = resolveCorrelationId(request.headers);
  const requestStartedAt = performance.now();
  const { mode, refreshSource } = options;
  let sessionValidationMs = 0;
  let authorizationResolutionMs = 0;
  let mediaResolutionTiming: MediaResolutionTiming | undefined;
  let authorizationContext: MediaAuthorizationTimingContext | undefined;
  let sourceRefreshLease: PlaybackSourceRefreshLease | undefined;
  let sourceRefreshProof: ForcedSourceRefreshProof | undefined;
  let sourceRefreshBinding: { viewerEName: string; streamId: string } | undefined;
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
    if (refreshSource) assertTrustedSourceRefreshRequest(request);
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const sessionValidationStartedAt = performance.now();
    const session = await getW3dsAuthService().getSession(accessToken);
    sessionValidationMs = elapsedMs(sessionValidationStartedAt);
    const { streamId } = await context.params;
    const library = createEVaultVideoLibrary();
    if (refreshSource) {
      // Validate this sealed viewer-bound stream locally before creating any
      // durable row. This is intentionally not an access proof: its only job
      // is to reject arbitrary opaque strings cheaply. A healthy ready source
      // then rejects this browser recovery before it can trigger any remote
      // eVault/shared-access work.
      library.inspectBoundStream(session.user, streamId);
      sourceRefreshBinding = { viewerEName: session.user.eName, streamId };
      sourceRefreshLease = await claimForcedSourceRefresh(sourceRefreshBinding);
      if (!sourceRefreshLease) {
        // A busy/expired durable handoff is not itself evidence about the
        // viewer's entitlement. Make one bounded, current proof first so a
        // truly revoked share keeps its explicit 403 instead of being masked
        // as a transient 503. A healthy proof still leaves the existing
        // cross-replica owner in charge and returns the normal retry state.
        await library.proveCurrentPlayableStreamForSourceRefresh(session.user, streamId, {
          priority: 'interactive',
          signal: request.signal,
        });
        throw sourceRefreshUnavailable();
      }
      // We own a recoverable lease, so now prove current source access before
      // invalidating or resolving anything. If this proof fails, the outer
      // catch conditionally releases our exact lease; a revoked viewer can
      // never publish a replacement source or evict an owner's healthy cache.
      sourceRefreshProof = await library.proveCurrentPlayableStreamForSourceRefresh(
        session.user,
        streamId,
        {
          priority: 'interactive',
          signal: request.signal,
        },
      );
    }
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
          // The user has explicitly opened this video.  Some older eVault
          // File endpoints require the GraphQL metadata compatibility path,
          // which can legitimately take longer than the speculative hover
          // deadline.  Give this one foreground authorization the normal
          // bounded source deadline instead of failing it early and forcing
          // a second, visibly slow recovery request.
          allowExtendedLegacyFileMetadataWait: true,
          // The library validates the stream and advances its source cache
          // generation before resolving. An old in-flight resolution can no
          // longer reinsert the rejected URL after this recovery starts.
          ...(refreshSource
            ? {
                forceSourceRefresh: true,
                ...(sourceRefreshProof ? { forcedSourceRefreshProof: sourceRefreshProof } : {}),
              }
            : {}),
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
        let localOnlySourceRefresh = false;
        let sourceRefreshLeaseForResult: PlaybackSourceRefreshLease | undefined;
        if (refreshSource) {
          sourceRefreshLeaseForResult = sourceRefreshLease;
          if (typeof resolvedMediaUrl !== 'string' || !sourceRefreshLeaseForResult) {
            throw sourceRefreshUnavailable();
          }
          const sourceExpiry = resolvePrivateMediaUrlCacheExpiry(resolvedMediaUrl);
          if (!sourceExpiry) {
            library.discardLocalForcedSourceResult?.(session.user, streamId);
            throw sourceRefreshUnavailable();
          }
          if (sourceExpiry.kind === 'unknown') {
            // Keep opaque redirects on the resolving replica only. They are
            // safe for the immediate local range burst, but without a
            // portable expiry they must never be placed in a cross-replica
            // ready handoff or issued as a durable recovery winner.
            const binding = sourceRefreshBinding;
            if (!binding) throw sourceRefreshUnavailable();
            if (!(await releaseForcedSourceRefresh(binding, sourceRefreshLeaseForResult))) {
              library.discardLocalForcedSourceResult?.(session.user, streamId);
              throw sourceRefreshUnavailable();
            }
            sourceRefreshLease = undefined;
            sourceRefreshBinding = undefined;
            localOnlySourceRefresh = true;
          }
          // This conditional update is the cross-replica winner fence. A
          // late request whose lease was superseded can never issue a new
          // cookie, even if its remote resolution completed successfully.
          if (
            !localOnlySourceRefresh &&
            !(await publishForcedSourceRefresh({
              viewerEName: session.user.eName,
              streamId,
              lease: sourceRefreshLeaseForResult,
              mediaUrl: resolvedMediaUrl,
            }))
          ) {
            // The resolver can have completed after its durable lease
            // expired. Another replica may now own a newer source, so fence
            // this process-local forced result before a later native Range
            // request can reuse it. The real library always provides this
            // synchronous, media-key-scoped cleanup; optional chaining keeps
            // narrow test doubles focused on the route behavior they model.
            library.discardLocalForcedSourceResult?.(session.user, streamId);
            throw sourceRefreshUnavailable();
          }
        }
        const receipt = mintSharedVideoAuthorizationReceipt({
          viewerEName: session.user.eName,
          streamId,
        });
        // Keep the cross-replica handoff strictly subordinate to the receipt:
        // the opaque value is verified before it is written or used as a cache
        // key, and the private URL remains server-only throughout.
        const verifiedReceipt = verifySharedVideoAuthorizationReceipt({
          receipt,
          viewerEName: session.user.eName,
          streamId,
        });
        if (!verifiedReceipt) {
          if (refreshSource) throw sourceRefreshUnavailable();
        } else if (refreshSource && !localOnlySourceRefresh) {
          // Re-read the receipt-bound durable state immediately before the
          // response. A second replica may have claimed a newer epoch after
          // our conditional publish; in that case this older request fails
          // closed instead of racing a stale Set-Cookie into the browser.
          if (
            !sourceRefreshLeaseForResult ||
            !(await isCurrentForcedSourceRefresh({
              receipt,
              viewerEName: session.user.eName,
              streamId,
              lease: sourceRefreshLeaseForResult,
            }))
          ) {
            // We may have published successfully and then lost the epoch to
            // a newer replica before this final durable read. This response
            // correctly fails closed, but the already-resolved local F1 must
            // be fenced as well so a later request cannot revive it after F2
            // has become the durable winner.
            if (typeof resolvedMediaUrl === 'string') {
              library.discardLocalForcedSourceResult?.(session.user, streamId);
            }
            throw sourceRefreshUnavailable();
          }
          // The bounded durable checks above are intentionally below the
          // receipt TTL. Verify again after all awaited work before sending a
          // browser cookie, so a delayed operation cannot issue a dead hint.
          if (
            !verifySharedVideoAuthorizationReceipt({
              receipt,
              viewerEName: session.user.eName,
              streamId,
            })
          ) {
            throw sourceRefreshUnavailable();
          }
          setAuthorizationReceiptCookies(response, receipt, streamId);
        } else {
          setAuthorizationReceiptCookies(response, receipt, streamId);
        }
      } catch (error) {
        // A dev/test setup can exercise the authorization route with a mock
        // library but without W3DS_AUTH_JWT_SECRET. The receipt is only an
        // optimization, so preserve the successful warmup in that case.
        if (!(error instanceof SharedVideoAuthorizationReceiptConfigurationError)) throw error;
        if (refreshSource) throw sourceRefreshUnavailable();
      }
    }
    reportTiming(true);
    return response;
  } catch (error) {
    // A failed resolver, publish, mint, or receipt recheck must not strand a
    // live cross-replica lease for its entire TTL. The conditional release is
    // harmless after a successful publish (it only matches the owner while
    // the row is still resolving), and cannot delete a newer owner's epoch.
    if (sourceRefreshLease && sourceRefreshBinding) {
      await releaseForcedSourceRefresh(sourceRefreshBinding, sourceRefreshLease);
    }
    // Only the explicit interactive recovery path may retire a card, and the
    // helper accepts only the private marker produced by a completed live
    // shared-source denial. Generic 401/403 errors remain visible/retryable.
    if (refreshSource && mode === 'interactive') recordConfirmedSharedPlaybackDenial(error);
    reportTiming(false, error);
    return errorResponse(error);
  }
}

/**
 * Keep the legacy API-wide receipt for recording-ticket and old Meshenger
 * routes, while the eVault player reads the stream-scoped receipt first. The
 * latter is what prevents a warmup for a different shared video from
 * replacing this video's browser handoff.
 */
function setAuthorizationReceiptCookies(
  response: NextResponse,
  receipt: string,
  streamId: string,
): void {
  response.cookies.set(
    sharedVideoStreamAuthorizationReceiptCookieName,
    receipt,
    sharedVideoStreamAuthorizationReceiptCookieOptions(streamId),
  );
  response.cookies.set(
    sharedVideoAuthorizationReceiptCookieName,
    receipt,
    sharedVideoAuthorizationReceiptCookieOptions(),
  );
}

/**
 * A source-refresh claim must complete before remote eVault work begins. A
 * recovery POST can continue an absent, failed, or expired handoff, but it
 * cannot replace a currently healthy ready source. Only the media GET that
 * observed an upstream source rejection can replace that exact ready epoch.
 * Store/configuration failure is deliberately indistinguishable from a busy
 * lease to the client; neither permits stale local source fallback.
 */
async function claimForcedSourceRefresh(input: {
  viewerEName: string;
  streamId: string;
}): Promise<PlaybackSourceRefreshLease | undefined> {
  return awaitBoundedForcedSourceRefreshClaim(input, () => claimPlaybackSourceRefresh(input));
}

/**
 * The durable winner publish and current-epoch recheck are each bounded. The
 * rejection handlers attach before the timeout race, so a late database
 * completion cannot produce an unhandled rejection after the HTTP response.
 */
async function publishForcedSourceRefresh(input: {
  viewerEName: string;
  streamId: string;
  lease: PlaybackSourceRefreshLease;
  mediaUrl: string;
}): Promise<boolean> {
  return awaitBoundedForcedSourceRefresh(() => publishPlaybackSourceRefresh(input));
}

async function isCurrentForcedSourceRefresh(input: {
  receipt: string;
  viewerEName: string;
  streamId: string;
  lease: PlaybackSourceRefreshLease;
}): Promise<boolean> {
  return awaitBoundedForcedSourceRefresh(async () => {
    const state = await readPlaybackSourceRefresh({
      receipt: input.receipt,
      viewerEName: input.viewerEName,
      streamId: input.streamId,
    });
    return state.kind === 'ready' && state.epoch === input.lease.epoch;
  });
}

function awaitBoundedForcedSourceRefresh(operation: () => Promise<boolean>): Promise<boolean> {
  const completed = Promise.resolve()
    .then(operation)
    .then(
      (value) => value === true,
      () => false,
    );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), forcedSourceRefreshHandoffTimeoutMs);
  });
  return Promise.race([completed, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function awaitBoundedForcedSourceRefreshClaim(
  binding: { viewerEName: string; streamId: string },
  operation: () => ReturnType<typeof claimPlaybackSourceRefresh>,
): Promise<PlaybackSourceRefreshLease | undefined> {
  let deadlineReached = false;
  const completed = Promise.resolve()
    .then(operation)
    .then(async (claim) => {
      if (claim.kind !== 'acquired') return undefined;
      // The HTTP caller has already failed closed, but a database statement
      // can still return its new lease after the deadline. Release that exact
      // owner asynchronously so it cannot make later retries wait a full
      // lease TTL. The conditional release cannot affect another epoch.
      if (deadlineReached) {
        await releaseForcedSourceRefresh(binding, claim.lease);
        return undefined;
      }
      return claim.lease;
    })
    .catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PlaybackSourceRefreshLease | undefined>((resolve) => {
    timeout = setTimeout(() => {
      deadlineReached = true;
      resolve(undefined);
    }, forcedSourceRefreshHandoffTimeoutMs);
  });
  return Promise.race([completed, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function releaseForcedSourceRefresh(
  binding: { viewerEName: string; streamId: string },
  lease: PlaybackSourceRefreshLease,
): Promise<boolean> {
  // A failed/opaque recovery must not poison every later player request with
  // an `unavailable` epoch. Exact lease deletion cannot affect a successor.
  return awaitBoundedForcedSourceRefresh(() =>
    releasePlaybackSourceRefresh({
      viewerEName: binding.viewerEName,
      streamId: binding.streamId,
      lease,
    }),
  );
}

function assertTrustedSourceRefreshRequest(request: NextRequest): void {
  assertTrustedMutationOrigin(request);
}

function sourceRefreshUnavailable(): EVaultVideoLibraryError {
  return new EVaultVideoLibraryError(
    'The video source is temporarily unavailable. Please try again.',
    'remote_unavailable',
    503,
  );
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
