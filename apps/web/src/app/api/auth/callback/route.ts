import { type NextRequest, NextResponse } from 'next/server';
import {
  loadServerSecurityConfig,
  type ServerSecurityConfig,
} from '../../../../server/server-config';
import {
  applyW3dsSessionCookies,
  getW3dsAuthService,
  W3dsAuthError,
  type W3dsCallbackInput,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

/**
 * The eID wallet returns to the redirect URL as a browser navigation. The
 * native W3DS payload uses `ename`; retain `w3id` support for server-to-server
 * clients that use the original field name.
 */
export function callbackInputFromSearchParams(searchParams: URLSearchParams): W3dsCallbackInput {
  const appVersion = searchParams.get('appVersion')?.trim();
  return {
    w3id: searchParams.get('w3id') ?? searchParams.get('ename') ?? '',
    session: searchParams.get('session') ?? '',
    signature: searchParams.get('signature') ?? '',
    ...(appVersion ? { appVersion } : {}),
  };
}

export function resolveCallbackPublicOrigin(
  request: NextRequest,
  config: Pick<ServerSecurityConfig, 'trustedOrigins'> = loadServerSecurityConfig(),
): string {
  return config.trustedOrigins[0] ?? request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  try {
    const input = (await request.json()) as W3dsCallbackInput;
    const service = getW3dsAuthService();
    const offerId = await service.completeOffer(input);
    const session = await service.getOfferSessionForCookie(offerId);

    // The eID Wallet protocol consumes an authentication token from the
    // callback response after it posts the signed session. Do not return the
    // refresh credential: the wallet only needs the short-lived access token.
    return NextResponse.json({ token: session.tokens.accessToken });
  } catch (error) {
    if (error instanceof W3dsAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Invalid authentication callback.' } },
      { status: 400 },
    );
  }
}

/**
 * Handles the eID Wallet's browser redirect after it signs a W3DS offer. The
 * original login page may be on another device (after scanning the QR code),
 * so it can also observe the completed offer through its normal status poll.
 */
export async function GET(request: NextRequest) {
  try {
    const service = getW3dsAuthService();
    const offerId = await service.completeOffer(
      callbackInputFromSearchParams(request.nextUrl.searchParams),
    );
    const session = await service.getOfferSessionForCookie(offerId);
    const response = NextResponse.redirect(new URL('/', resolveCallbackPublicOrigin(request)));
    applyW3dsSessionCookies(response.cookies, session);
    return response;
  } catch (error) {
    if (error instanceof W3dsAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Invalid authentication callback.' } },
      { status: 400 },
    );
  }
}
