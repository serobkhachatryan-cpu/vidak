import { NextResponse } from 'next/server';
import {
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
  w3dsRefreshCookieName,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  try {
    const { offerId } = await params;
    const result = await getW3dsAuthService().getOfferStatus(offerId);
    const response = NextResponse.json(result);
    if (result.status === 'completed') {
      setSessionCookies(response, await getW3dsAuthService().getOfferSessionForCookie(offerId));
    }
    return response;
  } catch (error) {
    if (error instanceof W3dsAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'Authentication is unavailable.' } },
      { status: 500 },
    );
  }
}

function setSessionCookies(
  response: NextResponse,
  session: { tokens: { accessToken: string; refreshToken?: string; expiresAt: string } },
) {
  const secure = process.env.NODE_ENV === 'production';
  const accessMaxAge = Math.max(
    0,
    Math.floor((new Date(session.tokens.expiresAt).getTime() - Date.now()) / 1000),
  );
  response.cookies.set(w3dsAccessCookieName, session.tokens.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: accessMaxAge,
  });
  if (session.tokens.refreshToken) {
    response.cookies.set(w3dsRefreshCookieName, session.tokens.refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });
  }
}
