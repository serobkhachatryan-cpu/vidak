import { Suspense } from 'react';
import { AuthPage } from '../../features/auth/auth-page';
import { SessionLoadingSkeleton } from '../../features/auth/auth-provider';

export default function RegisterPage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthPage mode="register" />
    </Suspense>
  );
}
