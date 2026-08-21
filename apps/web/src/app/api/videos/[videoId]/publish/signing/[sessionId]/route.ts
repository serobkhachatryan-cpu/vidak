import { type NextRequest, NextResponse } from 'next/server';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../../server/w3ds-auth';
import {
  getW3dsVideoPublicationSigningService,
  W3dsVideoPublicationSigningError,
} from '../../../../../../../server/w3ds-video-publication-signing';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ videoId: string; sessionId: string }> };

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof W3dsAuthError || error instanceof W3dsVideoPublicationSigningError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Signed video publication is unavailable.' } },
    { status: 500, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Authenticated owner polling endpoint for one signing offer. The browser gets
 * only lifecycle state and the completed video; signature verification remains
 * exclusively on the wallet callback route.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId, sessionId } = await context.params;
    const status = await getW3dsVideoPublicationSigningService().getOfferStatus({
      accessToken,
      videoId,
      sessionId,
    });
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
