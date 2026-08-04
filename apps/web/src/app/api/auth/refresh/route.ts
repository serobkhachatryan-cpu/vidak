import { type NextRequest, NextResponse } from 'next/server';
import {
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
  w3dsRefreshCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get(w3dsRefreshCookieName)?.value;
    if (!refreshToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const session = await getW3dsAuthService().refreshSession(refreshToken);
    const { refreshToken: _refreshToken, ...publicTokens } = session.tokens;
    const response = NextResponse.json({ ...session, tokens: publicTokens });
    const secure = process.env.NODE_ENV === 'production';
    response.cookies.set(w3dsAccessCookieName, session.tokens.accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 15 * 60,
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
