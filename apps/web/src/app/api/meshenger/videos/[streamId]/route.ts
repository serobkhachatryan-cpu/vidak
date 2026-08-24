import { type NextRequest, NextResponse } from 'next/server';
import { createMeshengerVideoLibrary, MeshengerVideoLibraryError } from '../../../../../server/meshenger-video-library';
import { getBearerToken, getW3dsAuthService, W3dsAuthError, w3dsAccessCookieName } from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, context: { params: Promise<{ streamId: string }> }) {
  try {
    const accessToken = getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken) throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const session = await getW3dsAuthService().getSession(accessToken);
    const { streamId } = await context.params;
    const mediaUrl = await createMeshengerVideoLibrary().resolveMediaUrl(session.user, streamId);
    const range = request.headers.get('range');
    const upstream = await fetch(mediaUrl, {
      cache: 'no-store',
      redirect: 'error',
      ...(range ? { headers: { Range: range } } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok && upstream.status !== 206) {
      throw new MeshengerVideoLibraryError('The video file is unavailable.', 'remote_rejected', 502);
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
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof MeshengerVideoLibraryError || error instanceof W3dsAuthError ? error.status : 500;
  const body =
    error instanceof MeshengerVideoLibraryError || error instanceof W3dsAuthError
      ? { error: { code: error.code, message: error.message } }
      : { error: { code: 'internal_error', message: 'Meshenger video playback is unavailable.' } };
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
