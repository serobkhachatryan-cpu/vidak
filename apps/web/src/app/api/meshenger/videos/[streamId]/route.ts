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
    let retriedSource = false;
    let renewedExpiredStream = false;
    let resolvedStreamId = streamId;
    let mediaUrl: string;
    try {
      mediaUrl = await library.resolveMediaUrl(session.user, streamId);
    } catch (error) {
      if (!(error instanceof MeshengerVideoLibraryError) || error.code !== 'stream_expired')
        throw error;
      const renewedStreamId = await library.renewPlayableStream(session.user, streamId);
      resolvedStreamId = renewedStreamId;
      mediaUrl = await library.resolveMediaUrl(session.user, renewedStreamId);
      renewedExpiredStream = true;
    }
    let upstream = await fetchUpstreamMedia(mediaUrl, request.headers.get('range'));
    if (!upstream.ok && upstream.status !== 206) {
      if ([401, 403, 404].includes(upstream.status)) {
        await discardUpstreamBody(upstream);
        await library.invalidateMediaUrl(session.user, resolvedStreamId);
        mediaUrl = await library.resolveMediaUrl(session.user, resolvedStreamId);
        upstream = await fetchUpstreamMedia(mediaUrl, request.headers.get('range'));
        retriedSource = true;
      }
    }
    if (!upstream.ok && upstream.status !== 206) {
      await discardUpstreamBody(upstream);
      throw new MeshengerVideoLibraryError(
        'The video file is unavailable.',
        'remote_rejected',
        502,
      );
    }
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
    });
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    logProxyFailure(error, correlationId);
    return errorResponse(error);
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

async function discardUpstreamBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable. Continue with the source refresh.
  }
}

/** Limit time to the upstream response headers, never the viewer's media stream. */
async function fetchUpstreamMedia(mediaUrl: string, range: string | null): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(mediaUrl, {
      cache: 'no-store',
      redirect: 'error',
      ...(range ? { headers: { Range: range } } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function errorResponse(error: unknown): NextResponse {
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
  return response;
}
