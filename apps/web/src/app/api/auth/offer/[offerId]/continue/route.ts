import { NextResponse } from 'next/server';
import {
  buildAuthHandoffPath,
  buildCookieHandoffHtml,
  getSafeReturnTo,
} from '../../../../../../features/auth/auth-session-handoff';
import { resolvePublicOrigin } from '../../../../../../server/public-origin';
import { resolveRequestCookieSecure } from '../../../../../../server/server-config';
import {
  applyW3dsSessionCookies,
  getW3dsAuthService,
  W3dsAuthError,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function loginRedirect(
  request: Request,
  offerId: string | undefined,
  returnTo: string,
): NextResponse {
  const url = new URL('/login', resolvePublicOrigin(request));
  url.searchParams.set('returnTo', returnTo);
  if (offerId) url.searchParams.set('offer', offerId);
  const response = NextResponse.redirect(url);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * HTML-navigation equivalent of the JSON status endpoint. It lets the
 * server-rendered login page finish authentication without browser fetch.
 */
export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const returnTo = getSafeReturnTo(new URL(request.url).searchParams.get('returnTo'));

  try {
    const service = getW3dsAuthService();
    const status = await service.getOfferStatus(offerId);
    if (status.status === 'pending') return loginRedirect(request, offerId, returnTo);
    if (status.status === 'expired' || status.status === 'failed') {
      return loginRedirect(request, undefined, returnTo);
    }

    // Set cookies on a 200 HTML response, then advance to handoff after the
    // cookie jar settles. Cookies set on a 3xx are not always sent next.
    const session = await service.getOfferSessionForCookie(offerId);
    const handoffPath = buildAuthHandoffPath(returnTo);
    const response = new NextResponse(buildCookieHandoffHtml(handoffPath), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    applyW3dsSessionCookies(response.cookies, session, resolveRequestCookieSecure(request));
    return response;
  } catch (error) {
    if (error instanceof W3dsAuthError) return loginRedirect(request, undefined, returnTo);
    return NextResponse.redirect(new URL('/login', request.url));
  }
}
