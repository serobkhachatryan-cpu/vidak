import { type NextRequest, NextResponse } from 'next/server';
import { assertTrustedMutationOrigin } from '../../../../server/request-security';
import {
  clearW3dsSessionCookies,
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
  w3dsRefreshCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
  } catch (error) {
    if (error instanceof W3dsAuthError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    throw error;
  }

  const accessToken =
    getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
  const refreshToken = request.cookies.get(w3dsRefreshCookieName)?.value;
  try {
    await getW3dsAuthService().logout(accessToken, refreshToken);
  } catch {
    // Logout remains idempotent; all browser credentials are cleared below.
  }
  const response = new NextResponse(null, { status: 204 });
  clearW3dsSessionCookies(response.cookies);
  return response;
}
