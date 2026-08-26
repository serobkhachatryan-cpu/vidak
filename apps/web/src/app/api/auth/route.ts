import { type NextRequest, NextResponse } from 'next/server';
import { normalizeEidAuthPayload } from '../../../server/eid-auth-transport';
import { getW3dsAuthService, W3dsAuthError } from '../../../server/w3ds-auth';

export const runtime = 'nodejs';

/**
 * The eID Wallet is a Tauri webview and posts from its own origin. This
 * narrowly scoped gateway is credential-free: it accepts only a one-time,
 * signed offer session, so no browser cookies are involved in this exchange.
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

/** Handles the eID Wallet webview's CORS preflight. */
export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: walletCorsHeaders });
}

/** Accepts an eID Wallet signed approval for the authenticated offer. */
export async function POST(request: NextRequest) {
  try {
    const input = normalizeEidAuthPayload(await request.json());
    const service = getW3dsAuthService();
    const offerId = await service.completeOffer(input);
    const session = await service.getOfferSessionForCookie(offerId);
    const token = session.tokens.accessToken;
    if (!token) {
      throw new W3dsAuthError('Authentication session is unavailable.', 'invalid_session', 401);
    }

    // The eID Wallet authentication transport expects a platform token after
    // it verifies the signed session. The browser still receives its own
    // HttpOnly cookies through the same-origin offer continuation route.
    return walletJson({ token });
  } catch (error) {
    if (error instanceof W3dsAuthError) {
      return walletJson(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return walletJson(
      { error: { code: 'validation_failed', message: 'Invalid eID authentication response.' } },
      { status: 400 },
    );
  }
}
