import { type NextRequest, NextResponse } from 'next/server';
import {
  getBearerToken,
  getW3dsAuthService,
  w3dsAccessCookieName,
  w3dsRefreshCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const accessToken =
    getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
  const refreshToken = request.cookies.get(w3dsRefreshCookieName)?.value;
  try {
    await getW3dsAuthService().logout(accessToken, refreshToken);
  } catch {
    // Logout remains idempotent; all browser credentials are cleared below.
  }
  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(w3dsAccessCookieName, '', { httpOnly: true, path: '/', maxAge: 0 });
  response.cookies.set(w3dsRefreshCookieName, '', { httpOnly: true, path: '/', maxAge: 0 });
  return response;
}
