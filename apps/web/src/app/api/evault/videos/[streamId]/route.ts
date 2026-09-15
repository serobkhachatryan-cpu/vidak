import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
  type ForcedSourceRefreshProof,
  type MediaResolutionTiming,
} from '../../../../../server/evault-video-library';
import {
  reportOperationalEvent,
  reportOperationalFailure,
  reportVideoPlaybackTiming,
  reportVideoSourceResolutionFailureTiming,
  resolveCorrelationId,
} from '../../../../../server/ops-observability';
import {
  claimPlaybackSourceRefresh,
  type PlaybackSourceRefreshClaim,
  type PlaybackSourceRefreshState,
  publishPlaybackSourceRefresh,
  readPlaybackSourceRefresh,
  releasePlaybackSourceRefresh,
} from '../../../../../server/playback-source-refresh';
import {
  isRefreshablePrivateMediaFailure,
  openPrivateMediaUpstream,
  type PrivateMediaUpstreamFailure,
  type PrivateMediaUpstreamResult,
  resolvePrivateMediaUrlCacheExpiry,
} from '../../../../../server/private-media-upstream';
import {
  fingerprintSharedVideoAuthorizationReceipt,
  SharedVideoAuthorizationReceiptConfigurationError,
  sharedVideoAuthorizationReceiptCookieName,
  sharedVideoStreamAuthorizationReceiptCookieName,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../server/shared-video-authorization-receipt';
import {
  type CachedMediaRange,
  cacheInitialMediaRange,
  getCachedMediaRange,
} from '../../../../../server/video-source-warmup';
import { recordConfirmedSharedPlaybackDenial } from '../../../../../server/video-space/shared-playback-card-quarantine';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

// A signed receipt gates every use of these per-process entries. It is the
// bounded (45-second) source-generation window for a viewer and stream; a
// rejected source advances the local revision before recovery can publish.
const receiptResolutionLocalTtlMs = 45_000;
const maxReceiptResolutionLocalEntries = 256;
const sourceRefreshReadTimeoutMs = 500;
const sourceRefreshClaimTimeoutMs = 750;
const sourceRefreshPublishTimeoutMs = 750;
const maxPendingReceiptResolutionReads = 128;
interface CachedReceiptResolution {
  mediaUrl: string;
  expiresAt: number;
  revision: number;
}
interface CachedSourceRefreshState {
  state: PlaybackSourceRefreshState;
  expiresAt: number;
}
/**
 * `unavailable` is a real durable fence: invalid/corrupt state must never
 * permit stale-source fallback. A database error or deadline is different:
 * an initial request has not observed a rejected source yet, so it can obtain
 * a fresh currently authorized source without weakening that fence.
 */
type BoundSourceRefreshStateRead =
  | { kind: 'state'; state: PlaybackSourceRefreshState }
  | { kind: 'store_unavailable' };
interface ReceiptResolutionRevision {
  revision: number;
  // A rejection must outlive every resolver that could already have captured
  // the preceding revision. This is intentionally independent from the URL
  // and state caches: deleting those entries is not permission to let an
  // older async resolver restore the rejected source.
  expiresAt: number;
}
interface PendingSourceRefreshStateRead {
  promise: Promise<BoundSourceRefreshStateRead>;
  active: boolean;
  expiresAt: number;
}
const cachedReceiptResolutions = new Map<string, CachedReceiptResolution>();
const receiptResolutionRevisions = new Map<string, ReceiptResolutionRevision>();
const cachedSourceRefreshStates = new Map<string, CachedSourceRefreshState>();
const pendingSourceRefreshStateReads = new Map<string, PendingSourceRefreshStateRead>();
let nextForcedSourceRefreshReadId = 1;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ streamId: string }> },
) {
  const correlationId = resolveCorrelationId(request.headers);
  const requestStartedAt = performance.now();
  // A player can make many seek/range requests while a video is playing. The
  // opening request is the latency signal we need, so never amplify log I/O
  // for every later seek.
  const requestedRange = request.headers.get('range');
  const shouldReportPlaybackTiming = isInitialPlaybackRange(requestedRange);
  let sessionValidationMs = 0;
  let sourceResolutionMs = 0;
  let mediaResolutionTiming: MediaResolutionTiming | undefined;
  let upstreamResponseHeadersMs: number | undefined;
  let upstreamAttempts = 0;
  let sourceResolutionFailed = false;
  const recordMediaResolutionTiming = (timing: MediaResolutionTiming): void => {
    mediaResolutionTiming = mergeMediaResolutionTiming(mediaResolutionTiming, timing);
  };
  const sourceTimingFields = () =>
    mediaResolutionTiming
      ? {
          mediaUrlCacheHit: mediaResolutionTiming.mediaUrlCacheHit,
          sharedAccessVerificationMs: mediaResolutionTiming.sharedAccessVerificationMs,
          eVaultResolutionMs: mediaResolutionTiming.eVaultResolutionMs,
          directFileDereferenceMs: mediaResolutionTiming.directFileDereferenceMs,
          platformTokenMs: mediaResolutionTiming.platformTokenMs,
          metadataReadMs: mediaResolutionTiming.metadataReadMs,
        }
      : {};
  const sourceFailureTimingFields = (): MediaResolutionTiming =>
    mediaResolutionTiming ?? {
      mediaUrlCacheHit: false,
      sharedAccessVerificationMs: 0,
      eVaultResolutionMs: 0,
      directFileDereferenceMs: 0,
      platformTokenMs: 0,
      metadataReadMs: 0,
    };
  const reportResponseReadyTiming = (initialRangeCacheHit: boolean): number => {
    const responseReadyMs = elapsedMs(requestStartedAt);
    if (!shouldReportPlaybackTiming) return responseReadyMs;
    reportVideoPlaybackTiming({
      correlationId,
      phase: 'response_ready',
      sessionValidationMs,
      sourceResolutionMs,
      ...sourceTimingFields(),
      ...(upstreamResponseHeadersMs === undefined ? {} : { upstreamResponseHeadersMs }),
      responseReadyMs,
      initialRangeCacheHit,
      upstreamAttempts,
    });
    return responseReadyMs;
  };
  const reportSourceResolutionFailureTiming = (): void => {
    if (!shouldReportPlaybackTiming || !sourceResolutionFailed) return;
    const timing = sourceFailureTimingFields();
    reportVideoSourceResolutionFailureTiming({
      correlationId,
      sessionValidationMs,
      sourceResolutionMs,
      ...timing,
      requestFailedMs: elapsedMs(requestStartedAt),
    });
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
    // New eVault cookies are scoped to the exact stream path, so opening or
    // hovering another video cannot overwrite this player's fast handoff.
    // Keep the API-wide cookie as a temporary compatibility fallback for
    // sessions that were started before the scoped cookie was deployed.
    const sharedAuthorizationReceipts = [
      request.cookies.get(sharedVideoStreamAuthorizationReceiptCookieName)?.value,
      request.cookies.get(sharedVideoAuthorizationReceiptCookieName)?.value,
    ].filter((receipt): receipt is string => typeof receipt === 'string' && receipt.length > 0);
    let retriedSource = false;
    let renewedExpiredStream = false;
    let resolvedStreamId = streamId;
    let usedReceiptBoundResolutionCache: string | undefined;
    let mediaUrl: string;
    const authorizationReceiptFor = (candidateStreamId: string): string | undefined =>
      sharedAuthorizationReceipts.find((receipt) =>
        hasVerifiedSharedAuthorizationReceipt(receipt, session.user.eName, candidateStreamId),
      );
    const resolveSource = async (candidateStreamId: string): Promise<string> => {
      const authorizationReceipt = authorizationReceiptFor(candidateStreamId);
      // Capture the receipt-local generation before any awaited source work.
      // A concurrent upstream rejection advances it; an older pending resolver
      // must never reinsert its URL under the newer generation when it lands.
      const receiptResolutionGeneration = authorizationReceipt
        ? receiptResolutionRevision(receiptResolutionCacheKey(authorizationReceipt))
        : undefined;
      const hasRecentSharedAuthorizationReceipt = Boolean(authorizationReceipt);
      try {
        if (authorizationReceipt) {
          // Read the durable recovery fence before *any* URL reuse. A local
          // source from another replica can otherwise reopen a redirect that
          // has already been rejected and fenced elsewhere. This replaces the
          // legacy receipt-cache read with the canonical eVault resolver's
          // source-bound cache after an absent state is confirmed.
          const refreshRead = await readBoundSourceRefreshState(
            authorizationReceipt,
            session.user.eName,
            candidateStreamId,
          );
          if (refreshRead.kind === 'store_unavailable') {
            // There is no rejected media URL on this initial path. Fall
            // through to a fresh, currently authorized resolver rather than
            // pretending an unavailable database is a durable stale-source
            // fence. Any actual upstream rejection below still takes the
            // strict cross-replica recovery path and fails closed if its
            // durable state cannot be read.
            reportOperationalEvent({
              category: 'video_playback',
              correlationId,
              code: 'source_refresh_store_unavailable_initial',
            });
          } else {
            const refreshState = refreshRead.state;
            if (refreshState.kind === 'ready') {
              await library.inspectPlayableStream(session.user, candidateStreamId, {
                priority: 'interactive',
                signal: request.signal,
              });
              if (
                library.adoptReadyPlaybackSourceAfterAuthorizationReceipt?.(
                  session.user,
                  candidateStreamId,
                  authorizationReceipt,
                  refreshState.mediaUrl,
                ) === false
              ) {
                throw sourceRefreshUnavailable();
              }
              usedReceiptBoundResolutionCache = authorizationReceipt;
              rememberReceiptResolution(authorizationReceipt, refreshState.mediaUrl);
              recordMediaResolutionTiming(cachedResolutionTiming());
              return refreshState.mediaUrl;
            }
            if (refreshState.kind === 'retryable') {
              // The former owner died after it fenced the old source. Take a
              // new epoch instead of falling back to that source or waiting for
              // the state-retention TTL to elapse.
              library.inspectBoundStream(session.user, candidateStreamId);
              return resolveFreshSource(candidateStreamId);
            }
            if (refreshState.kind === 'resolving' || refreshState.kind === 'unavailable') {
              throw sourceRefreshUnavailable();
            }
          }
          // A durable store error is intentionally not a reason to reuse a
          // local redirect: it may conceal a recovery claimed on another
          // replica. A fresh eVault resolution below remains authorized and
          // has its own source-expiry-aware cache.
          if (refreshRead.kind === 'state' && refreshRead.state.kind === 'absent') {
            const locallyResolvedMediaUrl = readLocalReceiptResolution(authorizationReceipt);
            if (locallyResolvedMediaUrl) {
              // A receipt is a bounded, viewer-and-stream-bound source
              // generation. It is valid only after the current durable fence
              // says no source recovery exists, and every reuse rechecks
              // current playable access before opening the private upstream.
              await library.inspectPlayableStream(session.user, candidateStreamId, {
                priority: 'interactive',
                signal: request.signal,
              });
              usedReceiptBoundResolutionCache = authorizationReceipt;
              recordMediaResolutionTiming(cachedResolutionTiming());
              return locallyResolvedMediaUrl;
            }
          }
        }
        const resolved =
          shouldReportPlaybackTiming || hasRecentSharedAuthorizationReceipt
            ? await library.resolveMediaUrl(session.user, candidateStreamId, {
                ...(shouldReportPlaybackTiming
                  ? { priority: 'interactive' as const, onTiming: recordMediaResolutionTiming }
                  : {}),
                ...(hasRecentSharedAuthorizationReceipt
                  ? { hasRecentSharedAuthorizationReceipt: true }
                  : {}),
              })
            : await library.resolveMediaUrl(session.user, candidateStreamId);
        // This local mapping is a receipt-bounded source generation. Later
        // ranges still make the library's current playable-access check, but
        // do not pay another eVault resolver after the durable fence has
        // confirmed that no cross-replica recovery is in progress.
        if (authorizationReceipt && receiptResolutionGeneration !== undefined) {
          rememberReceiptResolution(authorizationReceipt, resolved, receiptResolutionGeneration);
          // Treat this newly created receipt-local generation exactly like a
          // cache hit if upstream rejects it below. Otherwise its stale URL
          // could survive the recovery fence on this replica.
          usedReceiptBoundResolutionCache = authorizationReceipt;
        }
        return resolved;
      } catch (error) {
        sourceResolutionFailed = true;
        throw error;
      }
    };
    const resolveFreshSource = async (
      candidateStreamId: string,
      options?: {
        forcedSourceRefreshProof?: ForcedSourceRefreshProof;
        replaceReadyEpoch?: number;
        readReadyAfterInProgress?: () => Promise<string | undefined>;
      },
    ): Promise<string> => {
      const authorizationReceipt = authorizationReceiptFor(candidateStreamId);
      // A receipt is required to *read* a durable source handoff, but not to
      // acquire its recovery lease. Long videos can outlive the 45-second
      // receipt while their signed stream remains valid; still serialize a
      // rejected source so concurrent native ranges do not stampede eVault.
      const claim = await claimBoundSourceRefresh(session.user.eName, candidateStreamId, {
        ...(options?.replaceReadyEpoch !== undefined
          ? { replaceReadyEpoch: options.replaceReadyEpoch }
          : {}),
      });
      if (claim.kind === 'in_progress') {
        const recoveredMediaUrl = await options?.readReadyAfterInProgress?.();
        if (recoveredMediaUrl) return recoveredMediaUrl;
        if (authorizationReceipt) {
          rememberSourceRefreshState(authorizationReceipt, { kind: 'resolving', epoch: 0 });
        }
        throw sourceRefreshUnavailable();
      }
      if (claim.kind !== 'acquired') throw sourceRefreshUnavailable();

      if (authorizationReceipt) {
        rememberSourceRefreshState(authorizationReceipt, {
          kind: 'resolving',
          epoch: claim.lease.epoch,
        });
      }
      let resolvedFreshMediaUrl: string | undefined;
      const discardResolvedFreshSource = (): void => {
        if (!resolvedFreshMediaUrl) return;
        try {
          library.discardLocalForcedSourceResult(session.user, candidateStreamId);
        } catch {
          // Preserve the original recovery failure. The next request still
          // has the durable epoch fence, and this cleanup performs no I/O.
        } finally {
          resolvedFreshMediaUrl = undefined;
        }
      };
      try {
        const freshMediaUrl = await library.resolveMediaUrl(session.user, candidateStreamId, {
          priority: 'interactive',
          ...(authorizationReceipt ? { hasRecentSharedAuthorizationReceipt: true } : {}),
          forceSourceRefresh: true,
          ...(options?.forcedSourceRefreshProof
            ? { forcedSourceRefreshProof: options.forcedSourceRefreshProof }
            : {}),
          onTiming: recordMediaResolutionTiming,
        });
        resolvedFreshMediaUrl = freshMediaUrl;
        const freshSourceExpiry = resolvePrivateMediaUrlCacheExpiry(freshMediaUrl);
        if (!freshSourceExpiry) {
          discardResolvedFreshSource();
          await releaseBoundSourceRefresh({
            viewerEName: session.user.eName,
            streamId: candidateStreamId,
            lease: claim.lease,
          });
          throw sourceRefreshUnavailable();
        }
        if (freshSourceExpiry.kind === 'unknown') {
          // An opaque redirect can still serve this request's short local
          // range burst, but it has no portable expiry proof and must never
          // become an encrypted cross-replica handoff. Release the exact
          // lease before returning so another replica resolves canonically.
          const released = await releaseBoundSourceRefresh({
            viewerEName: session.user.eName,
            streamId: candidateStreamId,
            lease: claim.lease,
          });
          if (!released) {
            discardResolvedFreshSource();
            throw sourceRefreshUnavailable();
          }
          if (authorizationReceipt) {
            forgetSourceRefreshState(authorizationReceipt);
            replaceReceiptResolution(authorizationReceipt, freshMediaUrl);
            usedReceiptBoundResolutionCache = authorizationReceipt;
          }
          return freshMediaUrl;
        }
        const published = await publishBoundSourceRefresh({
          viewerEName: session.user.eName,
          streamId: candidateStreamId,
          lease: claim.lease,
          mediaUrl: freshMediaUrl,
        });
        if (!published) {
          // Our lease can expire while a slow source is resolving. Another
          // replica may already have published F2; discard F1 locally, then
          // use the same fresh durable reread as the in-progress claim path
          // before surfacing a transient failure to the player.
          discardResolvedFreshSource();
          const winnerMediaUrl = await options?.readReadyAfterInProgress?.();
          if (winnerMediaUrl) return winnerMediaUrl;
          throw sourceRefreshUnavailable();
        }
        if (authorizationReceipt) {
          rememberSourceRefreshState(authorizationReceipt, {
            kind: 'ready',
            epoch: claim.lease.epoch,
            mediaUrl: freshMediaUrl,
          });
          replaceReceiptResolution(authorizationReceipt, freshMediaUrl);
          usedReceiptBoundResolutionCache = authorizationReceipt;
        }
        return freshMediaUrl;
      } catch (error) {
        if (resolvedFreshMediaUrl) {
          // A source may have completed after this lease expired and another
          // replica may already have published a newer URL. It was safe for
          // the resolver to return the private URL only if this conditional
          // durable publish won; otherwise fence this replica's local result
          // before a later Range request can reuse it.
          discardResolvedFreshSource();
        }
        // Only the current lease may mark the row unavailable. A newer owner
        // is never disturbed by a late failure from this request.
        // Never let a best-effort lease release make the player wait behind a
        // stalled database. The conditional update cannot disturb a newer
        // owner, and the lease itself remains a bounded backstop.
        releaseSourceRefreshClaim({
          viewerEName: session.user.eName,
          streamId: candidateStreamId,
          lease: claim.lease,
        });
        if (authorizationReceipt) forgetSourceRefreshState(authorizationReceipt);
        throw error;
      }
    };
    const resolveAfterSourceRejection = async (
      candidateStreamId: string,
      rejectedMediaUrl: string,
    ): Promise<string> => {
      const authorizationReceipt = authorizationReceiptFor(candidateStreamId);
      if (!authorizationReceipt) {
        // A long recording can keep using its signed stream after the short
        // browser receipt expires. Before it claims a new recovery lease,
        // establish a current source proof and use its server-only capability
        // to consume a ready handoff published by another replica. This is
        // deliberately unavailable to ordinary no-receipt GETs, so it cannot
        // widen the durable source state into a browser authorization grant.
        const proof = await library.proveCurrentPlayableStreamForSourceRefresh(
          session.user,
          candidateStreamId,
          { priority: 'interactive', signal: request.signal },
        );
        const readCurrentProofRefreshState = async (options?: {
          forceFresh?: boolean;
        }): Promise<PlaybackSourceRefreshState> => {
          // The capability yields a receipt only to server code, and this
          // route keeps using its normal bounded/coalesced durable read. Check
          // again after that await: a concurrent access invalidation or the
          // short capability TTL must never authorize a ready URL late.
          const readReceipt = library.playbackSourceRefreshReadReceiptAfterCurrentProof(
            session.user,
            candidateStreamId,
            proof,
          );
          if (!readReceipt) return { kind: 'unavailable' };
          const refreshRead = await readBoundSourceRefreshState(
            readReceipt,
            session.user.eName,
            candidateStreamId,
            options,
          );
          const state =
            refreshRead.kind === 'state' ? refreshRead.state : ({ kind: 'unavailable' } as const);
          return library.playbackSourceRefreshReadReceiptAfterCurrentProof(
            session.user,
            candidateStreamId,
            proof,
          )
            ? state
            : { kind: 'unavailable' };
        };
        const adoptReadySource = (
          state: Extract<PlaybackSourceRefreshState, { kind: 'ready' }>,
        ) => {
          // This fences this replica's stale local cache before F1 is retried,
          // so later native ranges do not keep reopening the rejected S URL.
          if (
            !library.adoptReadyPlaybackSourceAfterCurrentProof(
              session.user,
              candidateStreamId,
              proof,
              state.mediaUrl,
            )
          ) {
            throw sourceRefreshUnavailable();
          }
          recordMediaResolutionTiming(cachedResolutionTiming());
          return state.mediaUrl;
        };
        const readDifferentReadySource = async (): Promise<string | undefined> => {
          const state = await readCurrentProofRefreshState({ forceFresh: true });
          return state.kind === 'ready' && state.mediaUrl !== rejectedMediaUrl
            ? adoptReadySource(state)
            : undefined;
        };
        const refreshState = await readCurrentProofRefreshState();
        if (refreshState.kind === 'ready' && refreshState.mediaUrl !== rejectedMediaUrl) {
          return adoptReadySource(refreshState);
        }
        // Claiming is the recovery linearization point. An active owner (or a
        // new F1 published just before the claim) returns in-progress, then
        // the callback takes one uncached, proof-validated reread. An
        // unavailable row is legitimately retryable and may be claimed.
        // If the row still names S, replace only that exact epoch.
        return resolveFreshSource(candidateStreamId, {
          forcedSourceRefreshProof: proof,
          ...(refreshState.kind === 'ready'
            ? {
                replaceReadyEpoch: refreshState.epoch,
              }
            : {}),
          readReadyAfterInProgress: readDifferentReadySource,
        });
      }

      // Another replica may already have recovered this exact binding while
      // this replica was still using its receipt-local source generation. On
      // a rejection, read the epoch once before claiming: consume a different
      // ready handoff rather than needlessly creating a third recovery epoch.
      const refreshRead = await readBoundSourceRefreshState(
        authorizationReceipt,
        session.user.eName,
        candidateStreamId,
      );
      // Once an upstream URL has actually failed, an unreadable durable store
      // cannot safely fall back to the stale source. Preserve the fence and
      // let the bounded browser retry surface a recoverable failure instead.
      if (refreshRead.kind === 'store_unavailable') throw sourceRefreshUnavailable();
      const refreshState = refreshRead.state;
      if (refreshState.kind === 'ready' && refreshState.mediaUrl !== rejectedMediaUrl) {
        await library.inspectPlayableStream(session.user, candidateStreamId, {
          priority: 'interactive',
          signal: request.signal,
        });
        if (
          library.adoptReadyPlaybackSourceAfterAuthorizationReceipt?.(
            session.user,
            candidateStreamId,
            authorizationReceipt,
            refreshState.mediaUrl,
          ) === false
        ) {
          throw sourceRefreshUnavailable();
        }
        replaceReceiptResolution(authorizationReceipt, refreshState.mediaUrl);
        usedReceiptBoundResolutionCache = authorizationReceipt;
        recordMediaResolutionTiming(cachedResolutionTiming());
        return refreshState.mediaUrl;
      }
      const readDifferentReadySource = async (): Promise<string | undefined> => {
        const refreshRead = await readBoundSourceRefreshState(
          authorizationReceipt,
          session.user.eName,
          candidateStreamId,
          { forceFresh: true },
        );
        if (refreshRead.kind === 'store_unavailable') return undefined;
        const state = refreshRead.state;
        if (state.kind === 'ready' && state.mediaUrl !== rejectedMediaUrl) {
          await library.inspectPlayableStream(session.user, candidateStreamId, {
            priority: 'interactive',
            signal: request.signal,
          });
          if (
            library.adoptReadyPlaybackSourceAfterAuthorizationReceipt?.(
              session.user,
              candidateStreamId,
              authorizationReceipt,
              state.mediaUrl,
            ) === false
          ) {
            throw sourceRefreshUnavailable();
          }
          replaceReceiptResolution(authorizationReceipt, state.mediaUrl);
          usedReceiptBoundResolutionCache = authorizationReceipt;
          recordMediaResolutionTiming(cachedResolutionTiming());
          return state.mediaUrl;
        }
        return undefined;
      };
      // Claiming is the recovery linearization point. If another replica wins
      // immediately before this request, consume its different ready handoff;
      // if the durable row still names rejected S, replace only that exact
      // epoch rather than broadly superseding a newer recovery.
      return resolveFreshSource(candidateStreamId, {
        ...(refreshState.kind === 'ready'
          ? {
              replaceReadyEpoch: refreshState.epoch,
            }
          : {}),
        readReadyAfterInProgress: readDifferentReadySource,
      });
    };
    const initialSourceResolutionStartedAt = performance.now();
    try {
      // This is the sole no-database fast path. It never reuses a source URL
      // or opens upstream: it can return only bytes already received under
      // this viewer's still-valid signed receipt. On a range-cache miss we
      // must consult the durable cross-replica refresh epoch before using any
      // URL, including an otherwise warm receipt-local one.
      const receipt = authorizationReceiptFor(streamId);
      if (receipt) {
        const cached = getReceiptLocalCachedMediaRange(receipt, session.user.eName, requestedRange);
        if (cached) {
          // A signed receipt binds this local byte entry to its viewer and
          // stream, but it is not a replacement for current media access.
          // The library deliberately keeps inspectBoundStream metadata-only;
          // retain its playable-source authorization check even though no
          // upstream URL is reused or opened on this path.
          await library.inspectPlayableStream(session.user, streamId, {
            priority: 'interactive',
            signal: request.signal,
          });
          recordMediaResolutionTiming(cachedResolutionTiming());
          reportResponseReadyTiming(true);
          return cachedRangeResponse(cached, correlationId);
        }
      }
      mediaUrl = await resolveSource(streamId);
      sourceResolutionFailed = false;
    } catch (error) {
      if (!(error instanceof EVaultVideoLibraryError) || error.code !== 'stream_expired')
        throw error;
      const renewedStreamId = await library.renewPlayableStream(session.user, streamId);
      resolvedStreamId = renewedStreamId;
      mediaUrl = await resolveSource(renewedStreamId);
      sourceResolutionFailed = false;
      renewedExpiredStream = true;
    } finally {
      sourceResolutionMs += elapsedMs(initialSourceResolutionStartedAt);
    }
    // A ready opening range is served from short-lived per-viewer RAM. A
    // pending background request must never block the real player: the source
    // response below starts immediately and is cached while it streams.
    const cached = getCachedMediaRange(session.user.eName, mediaUrl, requestedRange);
    if (cached) {
      reportResponseReadyTiming(true);
      return cachedRangeResponse(cached, correlationId);
    }
    const openUpstream = async (): Promise<PrivateMediaUpstreamResult> => {
      const opened = await openPrivateMediaUpstream({
        mediaUrl,
        range: requestedRange,
        signal: request.signal,
      });
      // The helper counts every physical request, including a validated CDN
      // redirect. Keep route telemetry honest without recording destinations.
      upstreamAttempts += opened.upstreamAttempts;
      upstreamResponseHeadersMs = (upstreamResponseHeadersMs ?? 0) + opened.responseHeadersMs;
      return opened;
    };
    let opened = await openUpstream();
    if (opened.kind === 'failure' && isRefreshablePrivateMediaFailure(opened.failure)) {
      const rejectedMediaUrl = mediaUrl;
      if (usedReceiptBoundResolutionCache) {
        forgetReceiptBoundResolutionCache(usedReceiptBoundResolutionCache);
      }
      // Fence the canonical eVault redirect before the recovery claim. This
      // reaches every replica through the durable eVault cache's generation,
      // so a concurrent player cannot revive the rejected URL while this
      // request is resolving its replacement.
      await library.invalidateMediaUrl?.(session.user, resolvedStreamId);
      const recoveredSourceResolutionStartedAt = performance.now();
      try {
        // The durable lease turns this source rejection into exactly one
        // current recovery across replicas. A concurrent range observes the
        // resolving state and cannot reuse the URL just rejected upstream.
        mediaUrl = await resolveAfterSourceRejection(resolvedStreamId, rejectedMediaUrl);
        sourceResolutionFailed = false;
      } finally {
        sourceResolutionMs += elapsedMs(recoveredSourceResolutionStartedAt);
      }
      const recoveredCached = getCachedMediaRange(session.user.eName, mediaUrl, requestedRange);
      if (recoveredCached) {
        reportResponseReadyTiming(true);
        return cachedRangeResponse(recoveredCached, correlationId);
      }
      opened = await openUpstream();
      retriedSource = true;
    }
    if (opened.kind === 'failure') {
      throw privateMediaFailureToLibraryError(opened.failure);
    }
    const upstream = opened.response;
    const finalUpstreamStartedAt = opened.finalUpstreamStartedAt;
    if (renewedExpiredStream || retriedSource) {
      reportOperationalEvent({
        category: 'video_playback',
        correlationId,
        code:
          renewedExpiredStream && retriedSource
            ? 'stream_renewed_source_recovered'
            : renewedExpiredStream
              ? 'stream_renewed'
              : 'source_recovered',
      });
    }
    const headers = new Headers({
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': correlationId,
    });
    // Deliberately omit Content-Length for the live ReadableStream. Caddy
    // flushes unknown-length upstream responses immediately, while the
    // browser retains full range semantics from Content-Range and
    // Accept-Ranges. Completed RAM-cached ranges keep their exact length.
    for (const header of ['content-type', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }
    // Prevent buffering proxies from withholding the first upstream bytes
    // while an eVault stream remains open. Caddy ignores this header; nginx
    // honors it, so it is safe across both supported reverse proxies.
    headers.set('X-Accel-Buffering', 'no');
    const responseReadyMs = reportResponseReadyTiming(false);
    const observedUpstreamBody = shouldReportPlaybackTiming
      ? observeFirstUpstreamByte(upstream.body, () => {
          reportVideoPlaybackTiming({
            correlationId,
            phase: 'first_byte',
            sessionValidationMs,
            sourceResolutionMs,
            ...sourceTimingFields(),
            ...(upstreamResponseHeadersMs === undefined ? {} : { upstreamResponseHeadersMs }),
            responseReadyMs,
            initialRangeCacheHit: false,
            upstreamAttempts,
            upstreamFirstByteMs: elapsedMs(finalUpstreamStartedAt),
            requestFirstByteMs: elapsedMs(requestStartedAt),
          });
        })
      : upstream.body;
    const body = cacheInitialMediaRange(
      session.user.eName,
      mediaUrl,
      observedUpstreamBody,
      upstream.headers.get('content-range'),
      upstream.headers.get('content-type'),
    );
    return new NextResponse(body, { status: upstream.status, headers });
  } catch (error) {
    reportSourceResolutionFailureTiming();
    // This is an authoritative browser media request. The helper records
    // nothing unless the library attached its private, completed-live-proof
    // marker, so an upstream 401/403 or transient source failure cannot hide
    // a valid shared card.
    recordConfirmedSharedPlaybackDenial(error);
    logProxyFailure(error, correlationId);
    return errorResponse(error, correlationId);
  }
}

function cachedRangeResponse(cached: CachedMediaRange, correlationId: string): NextResponse {
  // NextResponse needs an ArrayBuffer-backed BodyInit. This also prevents the
  // response stream from retaining the full cached entry after it is sent.
  const body = new Uint8Array(cached.body).buffer;
  return new NextResponse(body, {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Length': String(cached.body.byteLength),
      'Content-Range': cached.contentRange,
      'Content-Type': cached.contentType,
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': correlationId,
    },
  });
}

/**
 * Keep operational evidence for a failed private stream without recording a
 * stream id, eName, URL, or any other user data.  This distinguishes a
 * rejected source from an expired grant when diagnosing playback incidents.
 */
function logProxyFailure(error: unknown, correlationId: string): void {
  const known = error instanceof EVaultVideoLibraryError || error instanceof W3dsAuthError;
  reportOperationalFailure({
    category: 'video_playback',
    correlationId,
    code: known ? error.code : 'internal_error',
    // Do not include an upstream error: it can contain a signed source URL or
    // other private metadata. The fixed code above is enough for aggregation.
    error: new Error('Private video proxy failed.'),
  });
}

/**
 * Fetch resolving only proves that upstream response headers arrived. Wrap the
 * body so the separate timing event records when the first non-empty media
 * chunk actually crosses this proxy. The callback receives no request or
 * source data and does not affect the video bytes or backpressure.
 */
function observeFirstUpstreamByte(
  body: ReadableStream<Uint8Array> | null,
  onFirstByte: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  let firstByteObserved = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!firstByteObserved && chunk.byteLength > 0) {
          firstByteObserved = true;
          onFirstByte();
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

function mergeMediaResolutionTiming(
  current: MediaResolutionTiming | undefined,
  next: MediaResolutionTiming,
): MediaResolutionTiming {
  if (!current) return next;
  return {
    // A multi-step renewal/recovery only counts as fully cached when every
    // source resolution was cached. The numeric phases sum to the route's
    // aggregate source-resolution wait without recording source identity.
    mediaUrlCacheHit: current.mediaUrlCacheHit && next.mediaUrlCacheHit,
    sharedAccessVerificationMs:
      current.sharedAccessVerificationMs + next.sharedAccessVerificationMs,
    eVaultResolutionMs: current.eVaultResolutionMs + next.eVaultResolutionMs,
    directFileDereferenceMs: current.directFileDereferenceMs + next.directFileDereferenceMs,
    platformTokenMs: current.platformTokenMs + next.platformTokenMs,
    metadataReadMs: current.metadataReadMs + next.metadataReadMs,
  };
}

function isInitialPlaybackRange(range: string | null): boolean {
  return !range || /^bytes=0-\d*$/.test(range.trim());
}

function privateMediaFailureToLibraryError(
  failure: PrivateMediaUpstreamFailure,
): EVaultVideoLibraryError {
  if (failure.kind === 'pre_header_network' || failure.kind === 'pre_header_timeout') {
    return new EVaultVideoLibraryError(
      'The video source is temporarily unavailable.',
      'remote_unavailable',
      503,
    );
  }
  return new EVaultVideoLibraryError('The video file is unavailable.', 'remote_rejected', 502);
}

/**
 * The receipt is a cross-replica latency optimization, not a new browser
 * authorization mechanism. Invalid/missing receipts and a minimal dev/test
 * configuration therefore preserve the established source-resolution path.
 */
function hasVerifiedSharedAuthorizationReceipt(
  receipt: string | undefined,
  viewerEName: string,
  streamId: string,
): boolean {
  if (!receipt) return false;
  try {
    return verifySharedVideoAuthorizationReceipt({ receipt, viewerEName, streamId });
  } catch (error) {
    if (error instanceof SharedVideoAuthorizationReceiptConfigurationError) return false;
    throw error;
  }
}

function sourceRefreshUnavailable(): EVaultVideoLibraryError {
  return new EVaultVideoLibraryError(
    'The video source is temporarily unavailable. Please try again.',
    'remote_unavailable',
    503,
  );
}

/**
 * A hung claim must not pin the player forever. We cannot cancel a database
 * statement portably, so if it wins after the deadline we immediately release
 * its exact lease without opening a source. That prevents a late, abandoned
 * claim from blocking the next real recovery for its full lease TTL.
 */
async function claimBoundSourceRefresh(
  viewerEName: string,
  streamId: string,
  options?: { replaceReadyEpoch?: number },
): Promise<PlaybackSourceRefreshClaim> {
  const operation = Promise.resolve()
    .then(() =>
      claimPlaybackSourceRefresh({
        viewerEName,
        streamId,
        ...(options?.replaceReadyEpoch !== undefined
          ? { replaceReadyEpoch: options.replaceReadyEpoch }
          : {}),
      }),
    )
    .catch((): PlaybackSourceRefreshClaim => ({ kind: 'unavailable' }));
  const timedOut = Symbol('source-refresh-claim-timeout');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), sourceRefreshClaimTimeoutMs);
  });
  const result = await Promise.race([operation, deadline]);
  if (timeout) clearTimeout(timeout);
  if (result !== timedOut) return result;

  void operation.then((lateClaim) => {
    if (lateClaim.kind !== 'acquired') return;
    releaseSourceRefreshClaim({ viewerEName, streamId, lease: lateClaim.lease });
  });
  return { kind: 'unavailable' };
}

/**
 * Publish is another independent durable statement. Bound it just like a
 * claim: a late publish is still conditionally fenced by its lease, while the
 * current media request gets a bounded failure rather than waiting forever.
 */
async function publishBoundSourceRefresh(input: {
  viewerEName: string;
  streamId: string;
  lease: Extract<PlaybackSourceRefreshClaim, { kind: 'acquired' }>['lease'];
  mediaUrl: string;
}): Promise<boolean> {
  const operation = Promise.resolve()
    .then(() => publishPlaybackSourceRefresh(input))
    .then(
      (published) => published === true,
      () => false,
    );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), sourceRefreshPublishTimeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/**
 * Releases an exact resolving lease when no durable redirect may be
 * published. Like claim/publish, this must never leave the player waiting on
 * a stalled database operation; a false result means the local forced source
 * is discarded rather than returned across an unknown replica state.
 */
async function releaseBoundSourceRefresh(input: {
  viewerEName: string;
  streamId: string;
  lease: Extract<PlaybackSourceRefreshClaim, { kind: 'acquired' }>['lease'];
}): Promise<boolean> {
  const operation = Promise.resolve()
    .then(() => releasePlaybackSourceRefresh(input))
    .then(
      (released) => released === true,
      () => false,
    );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => resolve(false), sourceRefreshPublishTimeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function releaseSourceRefreshClaim(input: {
  viewerEName: string;
  streamId: string;
  lease: Extract<PlaybackSourceRefreshClaim, { kind: 'acquired' }>['lease'];
}): void {
  void releaseBoundSourceRefresh(input);
}

/**
 * Checks the durable cross-replica fence before the older per-receipt cache.
 * Only short-lived negative states are memoized. Caching an absent or ready
 * state across replicas would allow a later claim on another replica to be
 * bypassed, so those states always re-read the durable epoch on a cache miss.
 */
async function readBoundSourceRefreshState(
  receipt: string,
  viewerEName: string,
  streamId: string,
  options?: { forceFresh?: boolean },
): Promise<BoundSourceRefreshStateRead> {
  const now = Date.now();
  pruneReceiptLocalState(now);
  const baseKey = receiptResolutionCacheKey(receipt);
  // Recovery observes a source rejection, not ordinary playback state. Use a
  // one-shot key so the short negative fence from its first read cannot hide
  // a ready handoff published by another replica a moment later.
  const key = options?.forceFresh
    ? `${baseKey}\u0000force-refresh-read:${nextForcedSourceRefreshReadId++}`
    : baseKey;
  const cached = cachedSourceRefreshStates.get(key);
  if (!options?.forceFresh && cached && cached.expiresAt > now) {
    return { kind: 'state', state: cached.state };
  }

  const existing = pendingSourceRefreshStateReads.get(key);
  // Keep a timed-out database operation tracked until it truly settles. A
  // route-level deadline cannot cancel PostgreSQL; deleting its entry would
  // let every later range create another live query and exhaust the pool.
  if (existing) return existing.promise;
  if (pendingSourceRefreshStateReads.size >= maxPendingReceiptResolutionReads) {
    return { kind: 'store_unavailable' };
  }

  const entry: PendingSourceRefreshStateRead = {
    promise: Promise.resolve({ kind: 'store_unavailable' }),
    active: true,
    expiresAt: now + sourceRefreshReadTimeoutMs,
  };
  const databaseRead = Promise.resolve()
    .then(() => readPlaybackSourceRefresh({ receipt, viewerEName, streamId }))
    .then((state): BoundSourceRefreshStateRead => ({ kind: 'state', state }))
    .catch((): BoundSourceRefreshStateRead => ({ kind: 'store_unavailable' }));
  const completed = databaseRead
    .then((result) => {
      if (!entry.active || pendingSourceRefreshStateReads.get(key) !== entry) {
        return { kind: 'store_unavailable' } as BoundSourceRefreshStateRead;
      }
      if (result.kind === 'state' && !options?.forceFresh) {
        rememberSourceRefreshStateByKey(key, result.state, Date.now());
      }
      return result;
    })
    .finally(() => {
      if (pendingSourceRefreshStateReads.get(key) === entry) {
        pendingSourceRefreshStateReads.delete(key);
      }
    });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<BoundSourceRefreshStateRead>((resolve) => {
    timeout = setTimeout(() => {
      entry.active = false;
      resolve({ kind: 'store_unavailable' });
    }, sourceRefreshReadTimeoutMs);
  });
  // Store the deadline-wrapped promise, not the raw database read. Every
  // concurrent range must share the same bounded outcome; otherwise later
  // waiters can hang forever behind a stalled first query.
  entry.promise = Promise.race([completed, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  pendingSourceRefreshStateReads.set(key, entry);
  return entry.promise;
}

function rememberReceiptResolution(
  receipt: string,
  mediaUrl: string,
  expectedRevision?: number,
): void {
  const key = receiptResolutionCacheKey(receipt);
  cacheReceiptResolutionByKey(
    key,
    mediaUrl,
    Date.now(),
    expectedRevision ?? receiptResolutionRevision(key),
  );
}

function replaceReceiptResolution(receipt: string, mediaUrl: string): void {
  const key = receiptResolutionCacheKey(receipt);
  const revision = advanceReceiptResolutionRevision(key);
  cacheReceiptResolutionByKey(key, mediaUrl, Date.now(), revision);
}

function forgetReceiptBoundResolutionCache(receipt: string): void {
  const key = receiptResolutionCacheKey(receipt);
  advanceReceiptResolutionRevision(key);
  cachedReceiptResolutions.delete(key);
}

function rememberSourceRefreshState(receipt: string, state: PlaybackSourceRefreshState): void {
  rememberSourceRefreshStateByKey(receiptResolutionCacheKey(receipt), state, Date.now());
}

function rememberSourceRefreshStateByKey(
  key: string,
  state: PlaybackSourceRefreshState,
  now: number,
): void {
  if (state.kind === 'ready' || state.kind === 'absent' || state.kind === 'retryable') {
    cachedSourceRefreshStates.delete(key);
    return;
  }
  pruneReceiptLocalState(now);
  while (cachedSourceRefreshStates.size >= maxReceiptResolutionLocalEntries) {
    const oldestKey = cachedSourceRefreshStates.keys().next().value;
    if (!oldestKey) break;
    cachedSourceRefreshStates.delete(oldestKey);
  }
  cachedSourceRefreshStates.set(key, {
    state,
    // These states are fences, never authorization. A very short memo avoids
    // a thundering herd while allowing a completed/newer epoch to be observed
    // promptly on the next source-cache miss.
    expiresAt: now + sourceRefreshReadTimeoutMs,
  });
}

/**
 * Uses a receipt-local URL only to probe viewer-scoped resident bytes. The
 * caller validates current playable access before serving those bytes.
 */
function getReceiptLocalCachedMediaRange(
  receipt: string,
  viewerEName: string,
  requestedRange: string | null,
): CachedMediaRange | undefined {
  const now = Date.now();
  pruneReceiptLocalState(now);
  const key = receiptResolutionCacheKey(receipt);
  const cached = cachedReceiptResolutions.get(key);
  if (!cached || cached.revision !== receiptResolutionRevision(key) || cached.expiresAt <= now) {
    return undefined;
  }
  return getCachedMediaRange(viewerEName, cached.mediaUrl, requestedRange);
}

function readLocalReceiptResolution(receipt: string): string | undefined {
  const now = Date.now();
  pruneReceiptLocalState(now);
  const key = receiptResolutionCacheKey(receipt);
  const cached = cachedReceiptResolutions.get(key);
  if (!cached || cached.revision !== receiptResolutionRevision(key) || cached.expiresAt <= now) {
    return undefined;
  }
  return cached.mediaUrl;
}

function forgetSourceRefreshState(receipt: string): void {
  cachedSourceRefreshStates.delete(receiptResolutionCacheKey(receipt));
}

function receiptResolutionCacheKey(receipt: string): string {
  return fingerprintSharedVideoAuthorizationReceipt(receipt);
}

function receiptResolutionRevision(key: string): number {
  return receiptResolutionRevisions.get(key)?.revision ?? 0;
}

function advanceReceiptResolutionRevision(key: string): number {
  const now = Date.now();
  const currentEntry = receiptResolutionRevisions.get(key);
  const current = currentEntry && currentEntry.expiresAt > now ? currentEntry.revision : 0;
  const next = current < Number.MAX_SAFE_INTEGER ? current + 1 : 1;
  receiptResolutionRevisions.set(key, {
    revision: next,
    expiresAt: now + receiptResolutionLocalTtlMs,
  });
  return next;
}

function cacheReceiptResolutionByKey(
  key: string,
  mediaUrl: string,
  now: number,
  revision: number,
): void {
  pruneReceiptLocalState(now);
  if (receiptResolutionRevision(key) !== revision) return;
  // A receipt authorizes a viewer/stream pair; it is not evidence that the
  // eVault's object-storage redirect remains valid for the full receipt TTL.
  // Keep an unknown URL only for the helper's small in-process range burst,
  // and bound recognised signed URLs before their source expiration.
  const sourceExpiry = resolvePrivateMediaUrlCacheExpiry(mediaUrl, {
    now,
    maxTtlMs: receiptResolutionLocalTtlMs,
  });
  if (!sourceExpiry) return;
  const mediaExpiresAt = now + sourceExpiry.ttlMs;
  // A normal warm write may be the first entry for a receipt. Keep its
  // generation for at least as long as the URL so a later rejection can fence
  // an older resolver that began before the write.
  const existingRevision = receiptResolutionRevisions.get(key);
  if (!existingRevision || existingRevision.expiresAt < now + receiptResolutionLocalTtlMs) {
    receiptResolutionRevisions.set(key, {
      revision,
      expiresAt: now + receiptResolutionLocalTtlMs,
    });
  }
  while (cachedReceiptResolutions.size >= maxReceiptResolutionLocalEntries) {
    const oldestKey = cachedReceiptResolutions.keys().next().value;
    if (!oldestKey) break;
    cachedReceiptResolutions.delete(oldestKey);
  }
  cachedReceiptResolutions.set(key, {
    mediaUrl,
    expiresAt: mediaExpiresAt,
    revision,
  });
}

function pruneReceiptLocalState(now: number): void {
  for (const [key, cached] of cachedReceiptResolutions) {
    if (cached.expiresAt <= now) cachedReceiptResolutions.delete(key);
  }
  for (const [key, cached] of cachedSourceRefreshStates) {
    if (cached.expiresAt <= now) cachedSourceRefreshStates.delete(key);
  }
  for (const [_key, entry] of pendingSourceRefreshStateReads) {
    if (entry.expiresAt <= now) {
      entry.active = false;
    }
  }
  for (const [key, revision] of receiptResolutionRevisions) {
    if (revision.expiresAt <= now) {
      receiptResolutionRevisions.delete(key);
    }
  }
}

function cachedResolutionTiming(): MediaResolutionTiming {
  return {
    mediaUrlCacheHit: true,
    sharedAccessVerificationMs: 0,
    eVaultResolutionMs: 0,
    directFileDereferenceMs: 0,
    platformTokenMs: 0,
    metadataReadMs: 0,
  };
}

function errorResponse(error: unknown, correlationId: string): NextResponse {
  const status =
    error instanceof EVaultVideoLibraryError || error instanceof W3dsAuthError ? error.status : 500;
  const body =
    error instanceof EVaultVideoLibraryError || error instanceof W3dsAuthError
      ? { error: { code: error.code, message: error.message } }
      : { error: { code: 'internal_error', message: 'eVault video playback is unavailable.' } };
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Request-Id', correlationId);
  return response;
}
