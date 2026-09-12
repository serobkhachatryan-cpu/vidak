import { type NextRequest, NextResponse } from 'next/server';
import {
  createMeshengerVideoLibrary,
  MeshengerVideoLibraryError,
} from '../../../../../server/meshenger-video-library';
import {
  reportOperationalEvent,
  reportOperationalFailure,
  resolveCorrelationId,
} from '../../../../../server/ops-observability';
import {
  deletePlaybackResolutionCache,
  getPlaybackResolutionCache,
} from '../../../../../server/playback-resolution-cache';
import {
  isRefreshablePrivateMediaFailure,
  openPrivateMediaUpstream,
} from '../../../../../server/private-media-upstream';
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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ streamId: string }> },
) {
  const correlationId = resolveCorrelationId(request.headers);
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const session = await getW3dsAuthService().getSession(accessToken);
    const { streamId } = await context.params;
    const library = createMeshengerVideoLibrary();
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
      if (hasRecentSharedAuthorizationReceipt && !options?.bypassReceiptBoundResolutionCache) {
        const cachedMediaUrl = await readReceiptBoundResolutionCache(
          sharedAuthorizationReceipt,
          session.user.eName,
          candidateStreamId,
        );
        if (cachedMediaUrl) {
          // A cached URL is not an authorization grant. Confirm the opaque
          // signed stream is still valid and bound to this session before it
          // is ever handed to the private upstream transport.
          library.inspectBoundStream(session.user, candidateStreamId);
          usedReceiptBoundResolutionCache = true;
          return cachedMediaUrl;
        }
      }
      return hasRecentSharedAuthorizationReceipt
        ? await library.resolveMediaUrl(session.user, candidateStreamId, {
            hasRecentSharedAuthorizationReceipt: true,
          })
        : await library.resolveMediaUrl(session.user, candidateStreamId);
    };
    try {
      mediaUrl = await resolveSource(streamId);
    } catch (error) {
      if (!(error instanceof MeshengerVideoLibraryError) || error.code !== 'stream_expired')
        throw error;
      const renewedStreamId = await library.renewPlayableStream(session.user, streamId);
      resolvedStreamId = renewedStreamId;
      mediaUrl = await resolveSource(renewedStreamId);
      renewedExpiredStream = true;
    }
    const openUpstream = () =>
      openPrivateMediaUpstream({
        mediaUrl,
        range: request.headers.get('range'),
        signal: request.signal,
      });
    let upstreamResult = await openUpstream();
    if (
      upstreamResult.kind === 'failure' &&
      isRefreshablePrivateMediaFailure(upstreamResult.failure)
    ) {
      if (usedReceiptBoundResolutionCache) {
        // A stale cache row must never participate in the one bounded retry.
        // Cleanup is intentionally non-blocking and cannot affect playback.
        void deleteReceiptBoundResolutionCache(
          sharedAuthorizationReceipt,
          session.user.eName,
          resolvedStreamId,
        );
        usedReceiptBoundResolutionCache = false;
      }
      await library.invalidateMediaUrl(session.user, resolvedStreamId);
      mediaUrl = await resolveSource(resolvedStreamId, {
        bypassReceiptBoundResolutionCache: true,
      });
      upstreamResult = await openUpstream();
      retriedSource = true;
    }
    if (upstreamResult.kind === 'failure') {
      throw new MeshengerVideoLibraryError(
        'The video file is unavailable.',
        'remote_rejected',
        502,
      );
    }
    const upstream = upstreamResult.response;
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
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    logProxyFailure(error, correlationId);
    return errorResponse(error, correlationId);
  }
}

/** Logs operational outcome only; never stream IDs, eNames, source URLs, or credentials. */
function logProxyFailure(error: unknown, correlationId: string): void {
  const known = error instanceof MeshengerVideoLibraryError || error instanceof W3dsAuthError;
  reportOperationalFailure({
    category: 'video_playback',
    correlationId,
    code: known ? error.code : 'internal_error',
    // Do not include an upstream error: it can contain a signed source URL or
    // other private metadata. The fixed code above is enough for aggregation.
    error: new Error('Private video proxy failed.'),
  });
}

/** Invalid receipts never alter the established private-player behavior. */
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
 * The receipt cache is deliberately invisible when its backing store or
 * configuration is unavailable. The cache itself repeats the exact receipt,
 * viewer, and stream validation; this wrapper retains no source details.
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

/** A rejected cache-hit URL is removed best-effort before the one fresh resolve. */
function deleteReceiptBoundResolutionCache(
  receipt: string | undefined,
  viewerEName: string,
  streamId: string,
): Promise<boolean> {
  if (!receipt) return Promise.resolve(false);
  return deletePlaybackResolutionCache({ receipt, viewerEName, streamId }).catch(() => false);
}

function errorResponse(error: unknown, correlationId: string): NextResponse {
  const status =
    error instanceof MeshengerVideoLibraryError || error instanceof W3dsAuthError
      ? error.status
      : 500;
  const body =
    error instanceof MeshengerVideoLibraryError || error instanceof W3dsAuthError
      ? { error: { code: error.code, message: error.message } }
      : { error: { code: 'internal_error', message: 'Meshenger video playback is unavailable.' } };
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Request-Id', correlationId);
  return response;
}
