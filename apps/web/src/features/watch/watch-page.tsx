'use client';

import { WatchPageData } from '@w3ds/watch-page';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';

export function WatchPageFeature({ videoId }: { videoId: string }) {
  return (
    <ApplicationShell>
      <WatchPageData client={videoApiClient} videoId={videoId} />
    </ApplicationShell>
  );
}
