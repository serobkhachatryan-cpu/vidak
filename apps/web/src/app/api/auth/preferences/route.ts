import { type NextRequest, NextResponse } from 'next/server';
import { assertTrustedMutationOrigin } from '../../../../server/request-security';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
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

export async function GET(request: NextRequest) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const preferences = await getW3dsAuthService().getPreferences(accessToken);
    return NextResponse.json(preferences);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const body = (await request.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!body || typeof body !== 'object') {
      throw new W3dsAuthError('Preferences are required.', 'validation_failed', 400);
    }
    const preferences = await getW3dsAuthService().updatePreferences(accessToken, body);
    return NextResponse.json(preferences);
  } catch (error) {
    return errorResponse(error);
  }
}
