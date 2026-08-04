import { Suspense } from 'react';
import { AuthPage } from '../../features/auth/auth-page';
import { SessionLoadingSkeleton } from '../../features/auth/auth-provider';

export default function LoginPage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthPage mode="login" />
    </Suspense>
  );
}
