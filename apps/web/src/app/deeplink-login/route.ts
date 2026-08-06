import { type NextRequest, NextResponse } from 'next/server';
import { normalizeEidAuthPayload } from '../../server/eid-auth-transport';
import { loadServerSecurityConfig, type ServerSecurityConfig } from '../../server/server-config';
import { applyW3dsSessionCookies, getW3dsAuthService } from '../../server/w3ds-auth';

export const runtime = 'nodejs';

/** Resolves an externally reachable target when Next.js is behind a proxy. */
export function resolveDeeplinkPublicOrigin(
  request: NextRequest,
  config: Pick<ServerSecurityConfig, 'trustedOrigins'> = loadServerSecurityConfig(),
): string {
  return config.trustedOrigins[0] ?? request.nextUrl.origin;
}

function retryLoginResponse(request: NextRequest): NextResponse {
  const url = new URL('/login', resolveDeeplinkPublicOrigin(request));
  url.searchParams.set('error', 'eid');
  const response = NextResponse.redirect(url);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * Browser-navigation eID completion path. The wallet uses this endpoint after
 * opening a w3ds:// link directly instead of scanning it on another device.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const service = getW3dsAuthService();
    const offerId = await service.completeOffer(
      normalizeEidAuthPayload(Object.fromEntries(request.nextUrl.searchParams)),
    );
    const session = await service.getOfferSessionForCookie(offerId);
    const response = NextResponse.redirect(new URL('/', resolveDeeplinkPublicOrigin(request)));
    response.headers.set('Cache-Control', 'no-store');
    applyW3dsSessionCookies(response.cookies, session);
    return response;
  } catch {
    // A URL from a wallet contains authentication material; do not surface a
    // verifier error or copy it into a redirect query string.
    return retryLoginResponse(request);
  }
}
