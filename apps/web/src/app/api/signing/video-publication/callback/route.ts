import { type NextRequest, NextResponse } from 'next/server';
import {
  getW3dsVideoPublicationSigningService,
  W3dsVideoPublicationSigningError,
} from '../../../../../server/w3ds-video-publication-signing';

export const runtime = 'nodejs';

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
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function callbackInput(value: unknown): {
  sessionId: string;
  signature: string;
  w3id: string;
  message: string;
} {
  const payload = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : '',
    signature: typeof payload.signature === 'string' ? payload.signature : '',
    w3id: typeof payload.w3id === 'string' ? payload.w3id : '',
    message: typeof payload.message === 'string' ? payload.message : '',
  };
}

/** The eID Wallet webview may POST from its own origin. */
export function OPTIONS(): NextResponse {
  return new NextResponse(null, { status: 204, headers: walletCorsHeaders });
}

/**
 * Receives the signed session id, verifies it server-side, and publishes only
 * the single draft bound to that pending signing session.
 */
export async function POST(request: NextRequest) {
  try {
    await getW3dsVideoPublicationSigningService().completeOffer(
      callbackInput(await request.json()),
    );
    return walletJson({ ok: true });
  } catch (error) {
    if (error instanceof W3dsVideoPublicationSigningError) {
      return walletJson(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return walletJson(
      { error: { code: 'validation_failed', message: 'Invalid signing response.' } },
      { status: 400 },
    );
  }
}
