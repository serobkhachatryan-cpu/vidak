import { toBrowserAuthSession } from '@w3ds/auth';
import { type NextRequest, NextResponse } from 'next/server';
import {
  applyW3dsSessionCookies,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsRefreshCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get(w3dsRefreshCookieName)?.value;
    if (!refreshToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const session = await getW3dsAuthService().refreshSession(refreshToken);
    const response = NextResponse.json(toBrowserAuthSession(session));
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
      { error: { code: 'internal_error', message: 'Authentication is unavailable.' } },
      { status: 500 },
    );
  }
}
