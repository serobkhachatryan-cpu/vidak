import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthPage } from '../../features/auth/auth-page';
import { SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { getSafeReturnTo } from '../../features/auth/auth-session-handoff';
import { W3dsServerLoginPage } from '../../features/auth/w3ds-server-login-page';
import { loadServerSecurityConfig } from '../../server/server-config';
import { getW3dsAuthService, w3dsAccessCookieName } from '../../server/w3ds-auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; offer?: string; returnTo?: string }>;
}) {
  const query = await searchParams;
  const returnTo = getSafeReturnTo(query.returnTo);
  const config = loadServerSecurityConfig();
  if (config.authProvider === 'w3ds') {
    const publicOrigin = config.trustedOrigins[0];
    if (!publicOrigin)
      throw new Error('W3DS login requires a configured public application origin.');

    const accessToken = (await cookies()).get(w3dsAccessCookieName)?.value;
    if (accessToken) {
      try {
        await getW3dsAuthService().getSession(accessToken);
        redirect(returnTo);
      } catch {
        // Cookie present but invalid — show login so the user can retry.
      }
    }

    return (
      <W3dsServerLoginPage
        publicOrigin={publicOrigin}
        returnTo={returnTo}
        {...(query.offer ? { offerId: query.offer } : {})}
        {...(query.error === 'eid'
          ? {
              errorMessage:
                'The eID approval could not be verified. Create a new request and try again.',
            }
          : {})}
      />
    );
  }

  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthPage mode="login" />
    </Suspense>
  );
}
