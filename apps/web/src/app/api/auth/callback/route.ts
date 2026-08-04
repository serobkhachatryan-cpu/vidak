import { type NextRequest, NextResponse } from 'next/server';
import {
  getW3dsAuthService,
  W3dsAuthError,
  type W3dsCallbackInput,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

/**
 * eID is a Tauri webview and posts from its own origin. This callback does
 * not use cookies: it only accepts a unique signed session and returns the
 * resulting short-lived token to the wallet. It is therefore intentionally
 * separate from the same-origin cookie APIs.
 */
const walletCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
} as const;

function walletJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  for (const [name, value] of Object.entries(walletCorsHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}

/** Handles the eID webview's CORS preflight before the documented JSON POST. */
export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: walletCorsHeaders });
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
    return walletJson({ token: session.tokens.accessToken });
  } catch (error) {
    if (error instanceof W3dsAuthError) {
      return walletJson(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return walletJson(
      { error: { code: 'validation_failed', message: 'Invalid authentication callback.' } },
      { status: 400 },
    );
  }
}
