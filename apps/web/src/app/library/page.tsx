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
        title="Linked channel videos"
        description="Public videos from channels you chose to link to Vidak."
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
