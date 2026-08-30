'use client';

import { Suspense } from 'react';
import { AuthenticationGuard, SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { VideoSpacePage } from '../../features/home/video-space';

export default function YourVideosPage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <VideoSpacePage currentHref="/your-videos" />
      </AuthenticationGuard>
    </Suspense>
  );
}
