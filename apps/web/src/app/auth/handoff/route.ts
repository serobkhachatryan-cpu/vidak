import { type NextRequest, NextResponse } from 'next/server';
import { buildLoginPath, getSafeReturnTo } from '../../../features/auth/auth-session-handoff';
import { loadServerSecurityConfig, type ServerSecurityConfig } from '../../../server/server-config';
import { getW3dsAuthService, w3dsAccessCookieName } from '../../../server/w3ds-auth';

export const runtime = 'nodejs';

/** Resolves an externally reachable origin when Next.js is behind a proxy. */
export function resolveHandoffPublicOrigin(
  request: NextRequest,
  config: Pick<ServerSecurityConfig, 'trustedOrigins'> = loadServerSecurityConfig(),
): string {
  return config.trustedOrigins[0] ?? request.nextUrl.origin;
}

/**
 * Authoritative post-cookie eID handoff. Verifies the HttpOnly session cookie
 * server-side and redirects with HTTP — works without browser JavaScript.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const returnTo = getSafeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const origin = resolveHandoffPublicOrigin(request);

  const redirectTo = (path: string) => {
    const response = NextResponse.redirect(new URL(path, origin));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };

  const accessToken = request.cookies.get(w3dsAccessCookieName)?.value;
  if (!accessToken) return redirectTo(buildLoginPath(returnTo));

  try {
    await getW3dsAuthService().getSession(accessToken);
    return redirectTo(returnTo);
  } catch {
    return redirectTo(buildLoginPath(returnTo));
  }
}
