import { Suspense } from 'react';
import { AuthPage } from '../../features/auth/auth-page';
import { SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { W3dsServerLoginPage } from '../../features/auth/w3ds-server-login-page';
import { loadServerSecurityConfig } from '../../server/server-config';

export const dynamic = 'force-dynamic';

function safeReturnTo(value: string | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; offer?: string; returnTo?: string }>;
}) {
  const query = await searchParams;
  const config = loadServerSecurityConfig();
  if (config.authProvider === 'w3ds') {
    const publicOrigin = config.trustedOrigins[0];
    if (!publicOrigin)
      throw new Error('W3DS login requires a configured public application origin.');
    return (
      <W3dsServerLoginPage
        publicOrigin={publicOrigin}
        returnTo={safeReturnTo(query.returnTo)}
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
