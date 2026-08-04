import { NextResponse } from 'next/server';
import {
  loadServerSecurityConfig,
  type ServerSecurityConfig,
} from '../../../../../../server/server-config';
import {
  applyW3dsSessionCookies,
  getW3dsAuthService,
  W3dsAuthError,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function safeReturnTo(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function resolveContinuePublicOrigin(
  request: Request,
  config: Pick<ServerSecurityConfig, 'trustedOrigins'> = loadServerSecurityConfig(),
): string {
  return config.trustedOrigins[0] ?? new URL(request.url).origin;
}

function loginRedirect(
  request: Request,
  offerId: string | undefined,
  returnTo: string,
): NextResponse {
  const url = new URL('/login', resolveContinuePublicOrigin(request));
  url.searchParams.set('returnTo', returnTo);
  if (offerId) url.searchParams.set('offer', offerId);
  return NextResponse.redirect(url);
}

/**
 * HTML-navigation equivalent of the JSON status endpoint. It lets the
 * server-rendered login page finish authentication without browser fetch.
 */
export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));

  try {
    const service = getW3dsAuthService();
    const status = await service.getOfferStatus(offerId);
    if (status.status === 'pending') return loginRedirect(request, offerId, returnTo);
    if (status.status === 'expired' || status.status === 'failed') {
      return loginRedirect(request, undefined, returnTo);
    }

    const session = await service.getOfferSessionForCookie(offerId);
    const response = NextResponse.redirect(new URL(returnTo, resolveContinuePublicOrigin(request)));
    applyW3dsSessionCookies(response.cookies, session);
    return response;
  } catch (error) {
    if (error instanceof W3dsAuthError) return loginRedirect(request, undefined, returnTo);
    return NextResponse.redirect(new URL('/login', request.url));
  }
}
