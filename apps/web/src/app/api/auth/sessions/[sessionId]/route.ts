import { type NextRequest, NextResponse } from 'next/server';
import { assertTrustedMutationOrigin } from '../../../../../server/request-security';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { sessionId } = await context.params;
    const sessions = await getW3dsAuthService().revokeUserSession(accessToken, sessionId);
    return NextResponse.json(sessions);
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
