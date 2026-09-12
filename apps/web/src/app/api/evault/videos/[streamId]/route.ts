import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
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
  deletePlaybackResolutionCache,
  getPlaybackResolutionCache,
} from '../../../../../server/playback-resolution-cache';
import {
  isRefreshablePrivateMediaFailure,
  openPrivateMediaUpstream,
  type PrivateMediaUpstreamFailure,
  type PrivateMediaUpstreamResult,
} from '../../../../../server/private-media-upstream';
import {
  SharedVideoAuthorizationReceiptConfigurationError,
  sharedVideoAuthorizationReceiptCookieName,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../server/shared-video-authorization-receipt';
import {
  type CachedMediaRange,
  cacheInitialMediaRange,
  getCachedMediaRange,
} from '../../../../../server/video-source-warmup';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

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
    const sharedAuthorizationReceipt = request.cookies.get(
      sharedVideoAuthorizationReceiptCookieName,
    )?.value;
    let retriedSource = false;
    let renewedExpiredStream = false;
    let resolvedStreamId = streamId;
    let usedReceiptBoundResolutionCache = false;
    let mediaUrl: string;
    const resolveSource = async (
      candidateStreamId: string,
      options?: { bypassReceiptBoundResolutionCache?: boolean },
    ): Promise<string> => {
      const hasRecentSharedAuthorizationReceipt = hasVerifiedSharedAuthorizationReceipt(
        sharedAuthorizationReceipt,
        session.user.eName,
        candidateStreamId,
      );
      try {
        if (hasRecentSharedAuthorizationReceipt && !options?.bypassReceiptBoundResolutionCache) {
          const cachedMediaUrl = await readReceiptBoundResolutionCache(
            sharedAuthorizationReceipt,
            session.user.eName,
            candidateStreamId,
          );
          if (cachedMediaUrl) {
            // A durable URL cache is never an authorization grant. Keep the
            // inexpensive signed-stream binding check on every cache hit,
            // then let the 45-second receipt prove the immediately preceding
            // shared-source authorization.
            library.inspectBoundStream(session.user, candidateStreamId);
            usedReceiptBoundResolutionCache = true;
            recordMediaResolutionTiming(cachedResolutionTiming());
            return cachedMediaUrl;
          }
        }
        return shouldReportPlaybackTiming || hasRecentSharedAuthorizationReceipt
          ? await library.resolveMediaUrl(session.user, candidateStreamId, {
              ...(shouldReportPlaybackTiming
                ? { priority: 'interactive' as const, onTiming: recordMediaResolutionTiming }
                : {}),
              ...(hasRecentSharedAuthorizationReceipt
                ? { hasRecentSharedAuthorizationReceipt: true }
                : {}),
            })
          : await library.resolveMediaUrl(session.user, candidateStreamId);
      } catch (error) {
        sourceResolutionFailed = true;
        throw error;
      }
    };
    const initialSourceResolutionStartedAt = performance.now();
    try {
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
      if (usedReceiptBoundResolutionCache) {
        void deleteReceiptBoundResolutionCache(
          sharedAuthorizationReceipt,
          session.user.eName,
          resolvedStreamId,
        );
        usedReceiptBoundResolutionCache = false;
      }
      await library.invalidateMediaUrl(session.user, resolvedStreamId);
      const recoveredSourceResolutionStartedAt = performance.now();
      try {
        // The upstream explicitly rejected the cache-hit URL. Do not let a
        // concurrent cache writer hand us that same stale URL during the one
        // bounded recovery attempt.
        mediaUrl = await resolveSource(resolvedStreamId, {
          bypassReceiptBoundResolutionCache: true,
        });
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

/**
 * Database and configuration faults must leave this optimization invisible to
 * playback. The cache implementation repeats receipt verification internally;
 * this wrapper intentionally returns no private detail to the route or logs.
 */
async function readReceiptBoundResolutionCache(
  receipt: string | undefined,
  viewerEName: string,
  streamId: string,
): Promise<string | undefined> {
  if (!receipt) return undefined;
  try {
    return await getPlaybackResolutionCache({ receipt, viewerEName, streamId });
  } catch {
    return undefined;
  }
}

/** A stale private URL is removed best-effort before the route's one refresh. */
function deleteReceiptBoundResolutionCache(
  receipt: string | undefined,
  viewerEName: string,
  streamId: string,
): Promise<boolean> {
  if (!receipt) return Promise.resolve(false);
  return deletePlaybackResolutionCache({ receipt, viewerEName, streamId }).catch(() => false);
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
