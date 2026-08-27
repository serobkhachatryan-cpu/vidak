import { Suspense } from 'react';
import {
  AuthenticationGuard,
  SessionLoadingSkeleton,
} from '../../../../features/auth/auth-provider';
import { ImportedVideoWatchPage } from '../../../../features/imported-videos/imported-video-watch-page';

type ImportedWatchPageProps = { params: Promise<{ videoId: string }> };

export default async function Page({ params }: ImportedWatchPageProps) {
  const { videoId } = await params;
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <ImportedVideoWatchPage videoId={videoId} />
      </AuthenticationGuard>
    </Suspense>
  );
}
