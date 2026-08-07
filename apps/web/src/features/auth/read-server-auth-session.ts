import type { AuthSession } from '@w3ds/auth';
import { cookies } from 'next/headers';
import { getW3dsAuthService, w3dsAccessCookieName } from '../../server/w3ds-auth';

/**
 * Verifies the HttpOnly access cookie on the server (same check as `/auth/handoff`
 * and `/api/auth/session`). Used to seed the client auth query so the header and
 * guarded routes see the session on the first paint after eID continuation.
 *
 * Always reads `cookies()` so the root layout is request-time rendered and can
 * see post-handoff Set-Cookie values. Avoids `loadServerSecurityConfig()` so
 * production builds do not require AUTH_PROVIDER at compile time.
 */
export async function readServerAuthSession(): Promise<AuthSession | null> {
  const cookieStore = await cookies();

  const provider = (process.env.AUTH_PROVIDER ?? process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? '')
    .trim()
    .toLocaleLowerCase();
  if (provider !== 'w3ds') return null;

  try {
    const accessToken = cookieStore.get(w3dsAccessCookieName)?.value;
    if (!accessToken) return null;
    return await getW3dsAuthService().getSession(accessToken);
  } catch {
    return null;
  }
}
