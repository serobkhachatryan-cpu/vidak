'use client';

import { Page } from '@w3ds/ui';
import { Suspense } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { AuthenticationGuard, SessionLoadingSkeleton } from '../../features/auth/auth-provider';
import { ImportedVideosLibrary } from '../../features/imported-videos/imported-videos-library';

function LibraryContent() {
  return (
    <ApplicationShell currentHref="/library">
      <Page
        title="Linked public-channel videos"
        description="This optional library contains public videos from channels you choose to link. Your private W3DS videos are in Your video space."
      >
        <ImportedVideosLibrary />
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
