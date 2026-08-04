'use client';

import { UserProfilePageData } from '@w3ds/user-profile-page';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';

export function UserProfilePageFeature({ userId }: { userId: string }) {
  return (
    <ApplicationShell>
      <UserProfilePageData client={videoApiClient} userId={userId} />
    </ApplicationShell>
  );
}
