import { type NextRequest, NextResponse } from 'next/server';
import { resolvePublicOrigin } from '../../../../../../server/public-origin';
import { assertTrustedMutationOrigin } from '../../../../../../server/request-security';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';
import {
  getW3dsVideoPublicationSigningService,
  W3dsVideoPublicationSigningError,
} from '../../../../../../server/w3ds-video-publication-signing';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ videoId: string }> };

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof W3dsAuthError || error instanceof W3dsVideoPublicationSigningError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Signed video publication is unavailable.' } },
    { status: 500 },
  );
}

/**
 * Creates a one-time `w3ds://sign` offer for the authenticated owner's draft.
 * The response contains only the public URI/session metadata needed for QR or
 * deep-link presentation; signature verification stays on the callback route.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    const offer = await getW3dsVideoPublicationSigningService().createOffer({
      accessToken,
      videoId,
      publicBaseUrl: resolvePublicOrigin(request),
    });
    return NextResponse.json(offer, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
