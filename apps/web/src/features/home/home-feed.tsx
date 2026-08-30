'use client';

import { Page, Spinner } from '@w3ds/ui';
import { ApplicationShell } from '../../components/application-shell';
import { useAuthentication } from '../auth/auth-provider';
import { PublicHomeFeed, VideoSpacePage } from './video-space';

export function HomeFeed() {
  const { user, isLoading } = useAuthentication();

  if (isLoading) {
    return (
      <ApplicationShell currentHref="/">
        <Page title="Your video space" containerSize="full">
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" /> Loading your video space…
          </div>
        </Page>
      </ApplicationShell>
    );
  }

  if (user) return <VideoSpacePage />;
  return <PublicHomeFeed />;
}
