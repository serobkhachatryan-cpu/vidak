'use client';

import { WatchPageData } from '@w3ds/watch-page';
import { useRouter } from 'next/navigation';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';

export function WatchPageFeature({ videoId }: { videoId: string }) {
  const router = useRouter();
  return (
    <ApplicationShell>
      <WatchPageData
        client={videoApiClient}
        videoId={videoId}
        onBrowseVideos={() => router.push('/')}
        onPlaybackHelp={() => router.push('/support')}
      />
    </ApplicationShell>
  );
}
