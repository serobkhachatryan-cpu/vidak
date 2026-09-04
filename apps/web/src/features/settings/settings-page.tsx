'use client';

import {
  parseSettingsSectionParam,
  resolveActiveSettingsSection,
  SettingsPageData,
  settingsSectionsForCapabilities,
} from '@w3ds/settings-page';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { authApiClient } from '../../lib/auth-api-client';
import { videoApiClient } from '../../lib/video-api-client';
import { SessionLoadingSkeleton, useAuthentication } from '../auth/auth-provider';
import { VerifiedFullNameProfileAction } from '../auth/verified-full-name-profile-action';
import { useAppearancePreference } from './appearance-preference';

export function SettingsPageFeature() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, logout, updateSessionUser } = useAuthentication();
  const { setAppearance } = useAppearancePreference();
  const requestedSection = parseSettingsSectionParam(searchParams.get('section'));
  const sectionFromUrl = resolveActiveSettingsSection(
    settingsSectionsForCapabilities(authApiClient.capabilities),
    requestedSection ?? 'profile',
  );

  useEffect(() => {
    if (!searchParams.get('section') || requestedSection === sectionFromUrl) return;
    router.replace(`/settings?section=${sectionFromUrl}`, { scroll: false });
  }, [requestedSection, router, searchParams, sectionFromUrl]);

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
        defaultSection={sectionFromUrl}
        onSectionChange={(section) => {
          router.replace(`/settings?section=${section}`, { scroll: false });
        }}
        onAuthUserUpdate={updateSessionUser}
        onAppearancePreferenceChange={setAppearance}
        onViewLinkedVideos={() => router.push('/library')}
        onAccountDeleted={() => {
          void logout().then(() => router.replace('/'));
        }}
        profileExtras={<VerifiedFullNameProfileAction />}
      />
    </ApplicationShell>
  );
}
