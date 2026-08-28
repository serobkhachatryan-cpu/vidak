'use client';

import { Suspense } from 'react';
import { AuthenticationGuard, SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { EVaultVideoLibraryPage } from '../../features/meshenger/meshenger-video-library-page';

export default function YourVideosPage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <EVaultVideoLibraryPage />
      </AuthenticationGuard>
    </Suspense>
  );
}
