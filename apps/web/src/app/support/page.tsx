'use client';

import { Suspense } from 'react';
import { AuthenticationGuard, SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { SupportPageFeature } from '../../features/support/support-page';

export default function SupportPage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <SupportPageFeature />
      </AuthenticationGuard>
    </Suspense>
  );
}
