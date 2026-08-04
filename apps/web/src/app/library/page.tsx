'use client';

import { Card, Heading, Page, Text } from '@w3ds/ui';
import { Suspense } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import {
  AuthenticationGuard,
  SessionLoadingSkeleton,
  useCurrentUser,
} from '../../features/auth/auth-provider';

function LibraryContent() {
  const user = useCurrentUser();
  return (
    <ApplicationShell currentHref="/library">
      <Page title="Your library" description="Your saved videos and viewing activity.">
        <Card className="max-w-xl">
          <Heading as="h2" size="md">
            Welcome, {user?.displayName}
          </Heading>
          <Text tone="muted" className="mt-2">
            Your library is ready for saved videos, playlists, and watch history.
          </Text>
        </Card>
      </Page>
    </ApplicationShell>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <LibraryContent />
      </AuthenticationGuard>
    </Suspense>
  );
}
