'use client';

import { Suspense } from 'react';
import { AuthenticationGuard, SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { UploadPageFeature } from '../../features/upload/upload-page';

export default function UploadRoutePage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <UploadPageFeature />
      </AuthenticationGuard>
    </Suspense>
  );
}
