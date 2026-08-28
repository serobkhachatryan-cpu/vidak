'use client';

import { SettingsPageData } from '@w3ds/settings-page';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApplicationShell } from '../../components/application-shell';
import { authApiClient } from '../../lib/auth-api-client';
import { videoApiClient } from '../../lib/video-api-client';
import { SessionLoadingSkeleton, useAuthentication } from '../auth/auth-provider';
import { useAppearancePreference } from './appearance-preference';

export function SettingsPageFeature() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSection = searchParams.get('section');
  const activeSection = requestedSection === 'imports' ? 'imports' : undefined;
  const { session, logout, updateSessionUser } = useAuthentication();
  const { setAppearance } = useAppearancePreference();

  if (!session) return <SessionLoadingSkeleton />;

  return (
    <ApplicationShell currentHref="/settings">
      <SettingsPageData
        authClient={authApiClient}
        videoClient={videoApiClient}
        accessToken={session.tokens.accessToken ?? ''}
        userId={session.user.id}
        authUser={session.user}
        email={session.user.email ?? ''}
        displayName={session.user.displayName}
        {...(session.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {})}
        onAuthUserUpdate={updateSessionUser}
        onAppearancePreferenceChange={setAppearance}
        {...(activeSection ? { activeSection } : {})}
        onViewLinkedVideos={() => router.push('/library')}
        onAccountDeleted={() => {
          void logout().then(() => router.replace('/'));
        }}
      />
    </ApplicationShell>
  );
}
