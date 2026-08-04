'use client';

import { Suspense } from 'react';
import { AuthenticationGuard, SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { SettingsPageFeature } from '../../features/settings/settings-page';

export default function SettingsRoutePage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <SettingsPageFeature />
      </AuthenticationGuard>
    </Suspense>
  );
}
