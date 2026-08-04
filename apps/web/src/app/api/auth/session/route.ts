import { type NextRequest, NextResponse } from 'next/server';
import { authenticationErrorResponse } from '../../../../server/ops-http';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    return NextResponse.json(await getW3dsAuthService().getSession(accessToken));
  } catch (error) {
    return authenticationErrorResponse(error, request.headers);
  }
}
