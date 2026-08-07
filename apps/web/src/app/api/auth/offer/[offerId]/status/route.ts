import { toBrowserAuthSession } from '@w3ds/auth';
import { NextResponse } from 'next/server';
import { resolveRequestCookieSecure } from '../../../../../../server/server-config';
import {
  applyW3dsSessionCookies,
  getW3dsAuthService,
  W3dsAuthError,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ offerId: string }> }) {
  try {
    const { offerId } = await params;
    const result = await getW3dsAuthService().getOfferStatus(offerId);
    if (result.status !== 'completed') {
      return NextResponse.json(result);
    }

    const cookieSession = await getW3dsAuthService().getOfferSessionForCookie(offerId);
    const response = NextResponse.json({
      status: 'completed' as const,
      session: toBrowserAuthSession(cookieSession),
    });
    applyW3dsSessionCookies(response.cookies, cookieSession, resolveRequestCookieSecure(request));
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
