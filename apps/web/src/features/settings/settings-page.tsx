'use client';

import { SettingsPageData } from '@w3ds/settings-page';
import type { AppearancePreference } from '@w3ds/types';
import { useRouter } from 'next/navigation';
import { ApplicationShell } from '../../components/application-shell';
import { authApiClient } from '../../lib/auth-api-client';
import { videoApiClient } from '../../lib/video-api-client';
import { useAuthentication } from '../auth/auth-provider';
import { useAppearancePreference } from './appearance-preference';

export function SettingsPageFeature() {
  const router = useRouter();
  const { session, logout, updateSessionUser } = useAuthentication();
  const { setAppearance } = useAppearancePreference();

  if (!session) return null;

  return (
    <ApplicationShell currentHref="/settings">
      <SettingsPageData
        authClient={authApiClient}
        videoClient={videoApiClient}
        accessToken={session.tokens.accessToken}
        userId={session.user.id}
        email={session.user.email}
        displayName={session.user.displayName}
        {...(session.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {})}
        onAuthUserUpdate={updateSessionUser}
        onAppearancePreferenceChange={(appearance: AppearancePreference) => {
          setAppearance(appearance);
        }}
        onAccountDeleted={() => {
          void logout().then(() => router.replace('/'));
        }}
      />
    </ApplicationShell>
  );
}
