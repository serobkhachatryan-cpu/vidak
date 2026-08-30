import { type NextRequest, NextResponse } from 'next/server';
import { assertTrustedMutationOrigin } from '../../../../server/request-security';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function accessTokenFrom(request: NextRequest): string {
  const accessToken =
    getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
  if (!accessToken) {
    throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
  }
  return accessToken;
}

function authErrorResponse(error: unknown): NextResponse {
  if (error instanceof W3dsAuthError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          reason: error.reason ?? error.code,
        },
      },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: {
        code: 'internal_error',
        message: 'Authentication is unavailable.',
        reason: 'source_unavailable',
      },
    },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const accessToken = accessTokenFrom(request);
    const consent = await getW3dsAuthService().getVerifiedFullNameConsent(accessToken);
    return NextResponse.json(consent);
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    const body = (await request.json().catch(() => undefined)) as { grant?: unknown } | undefined;
    if (!body || typeof body !== 'object' || typeof body.grant !== 'boolean') {
      throw new W3dsAuthError(
        'Permission to use the verified full name is required.',
        'consent_required',
        400,
      );
    }
    const service = getW3dsAuthService();
    const user = body.grant
      ? await service.applyVerifiedFullName(accessToken, { grant: true })
      : await service.declineVerifiedFullName(accessToken);
    return NextResponse.json({ user });
  } catch (error) {
    return authErrorResponse(error);
  }
}
