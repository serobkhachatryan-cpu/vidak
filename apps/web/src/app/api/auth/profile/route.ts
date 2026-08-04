import { type NextRequest, NextResponse } from 'next/server';
import { assertTrustedMutationOrigin } from '../../../../server/request-security';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function PATCH(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const body = (await request.json().catch(() => undefined)) as
      | { displayName?: unknown; avatarUrl?: unknown }
      | undefined;
    if (!body || typeof body !== 'object') {
      throw new W3dsAuthError('Display name is required.', 'validation_failed', 400);
    }
    const user = await getW3dsAuthService().updateProfile(accessToken, {
      displayName: typeof body.displayName === 'string' ? body.displayName : '',
      ...(body.avatarUrl === null
        ? { avatarUrl: null }
        : typeof body.avatarUrl === 'string'
          ? { avatarUrl: body.avatarUrl }
          : {}),
    });
    return NextResponse.json(user);
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
