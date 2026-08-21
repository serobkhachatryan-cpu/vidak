'use client';

import { publicVideoWatchPath } from '@w3ds/api-client';
import { useRouter } from 'next/navigation';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';
import { SignedVideoPublicationUploadPage } from './signed-video-publication-upload-page';

/** Demo channel used by the mock API until creator channel ownership is modeled in auth. */
const uploadChannelId = 'channel-studio';

export function UploadPageFeature() {
  const router = useRouter();

  return (
    <ApplicationShell currentHref="/upload">
      <SignedVideoPublicationUploadPage
        client={videoApiClient}
        channelId={uploadChannelId}
        onWatchVideo={(video) => {
          if (video.publicVideoId) {
            router.push(publicVideoWatchPath(video.publicVideoId));
            return;
          }
          router.push(`/watch/${encodeURIComponent(video.id)}`);
        }}
      />
    </ApplicationShell>
  );
}
