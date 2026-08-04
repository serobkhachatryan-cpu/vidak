'use client';

import { ChannelPageData } from '@w3ds/channel-page';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';

export function ChannelPageFeature({ channelId }: { channelId: string }) {
  return (
    <ApplicationShell>
      <ChannelPageData client={videoApiClient} channelId={channelId} />
    </ApplicationShell>
  );
}
