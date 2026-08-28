'use client';

import { EmptyState, Page } from '@w3ds/ui';
import { Suspense } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { AuthenticationGuard, SessionLoadingSkeleton } from '../../features/auth/auth-provider';

function SubscriptionsContent() {
  return (
    <ApplicationShell currentHref="/subscriptions">
      <Page title="Subscriptions" description="New videos from the channels you follow.">
        <EmptyState
          icon="◉"
          title="No subscriptions yet"
          description="Channels you subscribe to will appear here with their latest videos."
        />
      </Page>
    </ApplicationShell>
  );
}

export default function SubscriptionsPage() {
  return (
    <Suspense fallback={<SessionLoadingSkeleton />}>
      <AuthenticationGuard>
        <SubscriptionsContent />
      </AuthenticationGuard>
    </Suspense>
  );
}
