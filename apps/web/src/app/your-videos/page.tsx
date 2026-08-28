'use client';

import { Suspense } from 'react';
import { AuthenticationGuard, SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { MeshengerVideoLibraryPage } from '../../features/meshenger/meshenger-video-library-page';

export default function YourVideosPage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <MeshengerVideoLibraryPage />
      </AuthenticationGuard>
    </Suspense>
  );
}
