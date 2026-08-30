'use client';

import type {
  AppearancePreference,
  AppLanguage,
  AuthDeviceSession,
  ChannelImportProvider,
  ChannelImportProviderStatus,
  ConnectedAccount,
  ConnectedAccountProvider,
  ImportedChannel,
  NotificationPreferences,
  PrivacySettings,
} from '@w3ds/types';
import {
  AppShell,
  type AppShellProps,
  EmptyState,
  ErrorState,
  Page,
  Section,
  Skeleton,
} from '@w3ds/ui';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { AppearanceSection } from './sections/appearance-section';
import { ChannelImportsSection } from './sections/channel-imports-section';
import { ConnectedAccountsSection } from './sections/connected-accounts-section';
import { DeleteAccountSection } from './sections/delete-account-section';
import { EmailSection } from './sections/email-section';
import { LanguageSection } from './sections/language-section';
import { NotificationsSection } from './sections/notifications-section';
import { PasswordSection } from './sections/password-section';
import { PrivacySection } from './sections/privacy-section';
import { ProfileSection } from './sections/profile-section';
import { SessionsSection } from './sections/sessions-section';
import {
  type SettingsPageState,
  type SettingsSectionId,
  settingsNavId,
  settingsPanelId,
  settingsSectionDescriptions,
  settingsSectionLabels,
  settingsSectionOrder,
} from './settings-constants';
import { SettingsNav } from './settings-nav';
import { resolveActiveSettingsSection } from './settings-page-helpers';
import type {
  DeleteAccountFormErrors,
  DeleteAccountFormInput,
  EmailFormErrors,
  EmailFormInput,
  PasswordFormErrors,
  PasswordFormInput,
  ProfileFormErrors,
  ProfileFormInput,
} from './settings-validation';
import { cx } from './styles';

export type { SettingsPageState };

/** Props owned by `SettingsPageData` so the presentational page stays dumb. */
export type SettingsPageDataOwnedProp =
  | 'state'
  | 'sections'
  | 'email'
  | 'profile'
  | 'avatarUrl'
  | 'profileErrors'
  | 'avatarError'
  | 'profileSuccess'
  | 'profileFormError'
  | 'isSavingProfile'
  | 'isUploadingAvatar'
  | 'onProfileChange'
  | 'onAvatarSelect'
  | 'onSaveProfile'
  | 'emailForm'
  | 'emailErrors'
  | 'emailSuccess'
  | 'emailFormError'
  | 'isSavingEmail'
  | 'onEmailChange'
  | 'onSaveEmail'
  | 'passwordForm'
  | 'passwordErrors'
  | 'passwordSuccess'
  | 'passwordFormError'
  | 'isSavingPassword'
  | 'onPasswordChange'
  | 'onSavePassword'
  | 'notifications'
  | 'notificationsError'
  | 'notificationsDisabled'
  | 'onNotificationToggle'
  | 'privacy'
  | 'privacyError'
  | 'privacyDisabled'
  | 'onPrivacyToggle'
  | 'appearance'
  | 'appearanceError'
  | 'onAppearanceChange'
  | 'language'
  | 'languageError'
  | 'languageSuccess'
  | 'onLanguageChange'
  | 'connectedAccounts'
  | 'connectedAccountsLoading'
  | 'connectedAccountsPendingProvider'
  | 'connectedAccountsError'
  | 'onConnectAccount'
  | 'onDisconnectAccount'
  | 'channelImportProviders'
  | 'channelImportChannels'
  | 'channelImportsLoading'
  | 'channelImportsPendingProvider'
  | 'channelImportsAddingPublicYouTube'
  | 'channelImportsError'
  | 'channelImportsSuccess'
  | 'onConnectChannelImport'
  | 'onAddPublicYouTubeChannel'
  | 'onRetryChannelImports'
  | 'sessions'
  | 'sessionsLoading'
  | 'sessionsPendingId'
  | 'sessionsError'
  | 'sessionsEmpty'
  | 'onRevokeSession'
  | 'deleteForm'
  | 'deleteErrors'
  | 'deleteFormError'
  | 'isDeletingAccount'
  | 'onDeleteFormChange'
  | 'onDeleteAccount'
  | 'onRetry';

export interface SettingsPageProps {
  state?: SettingsPageState;
  /** Capability-filtered section list. Defaults to the full settings nav. */
  sections?: readonly SettingsSectionId[];
  activeSection?: SettingsSectionId;
  defaultSection?: SettingsSectionId;
  onSectionChange?: (section: SettingsSectionId) => void;
  email?: string;
  profile?: ProfileFormInput;
  avatarUrl?: string;
  profileErrors?: ProfileFormErrors;
  avatarError?: string;
  profileSuccess?: string;
  profileFormError?: string;
  isSavingProfile?: boolean;
  isUploadingAvatar?: boolean;
  onProfileChange?: (patch: Partial<ProfileFormInput>) => void;
  onAvatarSelect?: (file: File) => void;
  onSaveProfile?: () => void;
  /** Optional Profile-section content (for example a verified-name action). */
  profileExtras?: ReactNode;
  emailForm?: EmailFormInput;
  emailErrors?: EmailFormErrors;
  emailSuccess?: string;
  emailFormError?: string;
  isSavingEmail?: boolean;
  onEmailChange?: (patch: Partial<EmailFormInput>) => void;
  onSaveEmail?: () => void;
  passwordForm?: PasswordFormInput;
  passwordErrors?: PasswordFormErrors;
  passwordSuccess?: string;
  passwordFormError?: string;
  isSavingPassword?: boolean;
  onPasswordChange?: (patch: Partial<PasswordFormInput>) => void;
  onSavePassword?: () => void;
  notifications?: NotificationPreferences;
  notificationsError?: string;
  notificationsDisabled?: boolean;
  onNotificationToggle?: (key: keyof NotificationPreferences, checked: boolean) => void;
  privacy?: PrivacySettings;
  privacyError?: string;
  privacyDisabled?: boolean;
  onPrivacyToggle?: (key: keyof PrivacySettings, checked: boolean) => void;
  appearance?: AppearancePreference;
  appearanceError?: string;
  onAppearanceChange?: (appearance: AppearancePreference) => void;
  language?: AppLanguage;
  languageError?: string;
  languageSuccess?: string;
  onLanguageChange?: (language: AppLanguage) => void;
  connectedAccounts?: readonly ConnectedAccount[];
  connectedAccountsLoading?: boolean;
  connectedAccountsPendingProvider?: ConnectedAccountProvider;
  connectedAccountsError?: string;
  onConnectAccount?: (provider: ConnectedAccountProvider) => void;
  onDisconnectAccount?: (provider: ConnectedAccountProvider) => void;
  channelImportProviders?: readonly ChannelImportProviderStatus[];
  channelImportChannels?: readonly ImportedChannel[];
  channelImportsLoading?: boolean;
  channelImportsPendingProvider?: ChannelImportProvider;
  channelImportsAddingPublicYouTube?: boolean;
  channelImportsError?: string;
  channelImportsSuccess?: string;
  onConnectChannelImport?: (provider: ChannelImportProvider) => void;
  onAddPublicYouTubeChannel?: (source: string) => void;
  onRetryChannelImports?: () => void;
  onViewLinkedVideos?: () => void;
  sessions?: readonly AuthDeviceSession[];
  sessionsLoading?: boolean;
  sessionsPendingId?: string;
  sessionsError?: string;
  sessionsEmpty?: boolean;
  onRevokeSession?: (sessionId: string) => void;
  deleteForm?: DeleteAccountFormInput;
  deleteErrors?: DeleteAccountFormErrors;
  deleteFormError?: string;
  isDeletingAccount?: boolean;
  onDeleteFormChange?: (patch: Partial<DeleteAccountFormInput>) => void;
  onDeleteAccount?: () => void;
  errorTitle?: ReactNode;
  errorDescription?: ReactNode;
  onRetry?: () => void;
  shell?: Omit<AppShellProps, 'children'>;
  theme?: 'light' | 'dark';
  className?: string;
}

const emptyProfile: ProfileFormInput = { displayName: '', handle: '', bio: '' };
const emptyEmail: EmailFormInput = { email: '', password: '' };
const emptyPassword: PasswordFormInput = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};
const emptyDelete: DeleteAccountFormInput = { password: '', confirmation: '' };

function SettingsPageSkeleton() {
  const skeletonKeys = [
    'nav-1',
    'nav-2',
    'nav-3',
    'nav-4',
    'nav-5',
    'nav-6',
    'nav-7',
    'nav-8',
  ] as const;
  return (
    <div role="status" aria-busy="true" aria-label="Loading settings" className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="space-y-2">
          {skeletonKeys.map((key) => (
            <Skeleton key={key} className="h-9 w-full" />
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}

export function SettingsPage({
  state = 'ready',
  sections = settingsSectionOrder,
  activeSection,
  defaultSection = 'profile',
  onSectionChange,
  email = '',
  profile = emptyProfile,
  avatarUrl,
  profileErrors,
  avatarError,
  profileSuccess,
  profileFormError,
  isSavingProfile,
  isUploadingAvatar,
  onProfileChange,
  onAvatarSelect,
  onSaveProfile,
  profileExtras,
  emailForm = emptyEmail,
  emailErrors,
  emailSuccess,
  emailFormError,
  isSavingEmail,
  onEmailChange,
  onSaveEmail,
  passwordForm = emptyPassword,
  passwordErrors,
  passwordSuccess,
  passwordFormError,
  isSavingPassword,
  onPasswordChange,
  onSavePassword,
  notifications,
  notificationsError,
  notificationsDisabled,
  onNotificationToggle,
  privacy,
  privacyError,
  privacyDisabled,
  onPrivacyToggle,
  appearance = 'system',
  appearanceError,
  onAppearanceChange,
  language = 'en',
  languageError,
  languageSuccess,
  onLanguageChange,
  connectedAccounts = [],
  connectedAccountsLoading,
  connectedAccountsPendingProvider,
  connectedAccountsError,
  onConnectAccount,
  onDisconnectAccount,
  channelImportProviders = [],
  channelImportChannels = [],
  channelImportsLoading,
  channelImportsPendingProvider,
  channelImportsAddingPublicYouTube,
  channelImportsError,
  channelImportsSuccess,
  onConnectChannelImport,
  onAddPublicYouTubeChannel,
  onRetryChannelImports,
  onViewLinkedVideos,
  sessions = [],
  sessionsLoading,
  sessionsPendingId,
  sessionsError,
  sessionsEmpty,
  onRevokeSession,
  deleteForm = emptyDelete,
  deleteErrors,
  deleteFormError,
  isDeletingAccount,
  onDeleteFormChange,
  onDeleteAccount,
  errorTitle = 'Could not load settings',
  errorDescription = 'Please check your connection and try again.',
  onRetry,
  shell,
  theme,
  className,
}: SettingsPageProps) {
  const scope = useId();
  const initialSection = resolveActiveSettingsSection(sections, defaultSection);
  const [selectedSection, setSelectedSection] = useState<SettingsSectionId>(initialSection);
  const preferredSection = activeSection ?? selectedSection;
  const currentSection = resolveActiveSettingsSection(sections, preferredSection);

  useEffect(() => {
    if (activeSection !== undefined) return;
    setSelectedSection(resolveActiveSettingsSection(sections, defaultSection));
  }, [activeSection, defaultSection, sections]);

  const changeSection = (section: SettingsSectionId) => {
    if (activeSection === undefined) setSelectedSection(section);
    onSectionChange?.(section);
  };

  const content =
    state === 'loading' ? (
      <SettingsPageSkeleton />
    ) : state === 'error' ? (
      <ErrorState
        title={errorTitle}
        description={errorDescription}
        {...(onRetry ? { retry: onRetry } : {})}
      />
    ) : state === 'empty' ? (
      <EmptyState
        icon="◌"
        title="Settings unavailable"
        description="Sign in again to manage your account settings."
      />
    ) : (
      <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
        <SettingsNav
          scope={scope}
          sections={sections}
          activeSection={currentSection}
          onChange={changeSection}
        />
        <div
          role="tabpanel"
          id={settingsPanelId(scope, currentSection)}
          aria-labelledby={settingsNavId(scope, currentSection)}
        >
          <Section
            title={settingsSectionLabels[currentSection]}
            description={settingsSectionDescriptions[currentSection]}
          >
            {currentSection === 'profile' && (
              <ProfileSection
                value={profile}
                {...(avatarUrl ? { avatarUrl } : {})}
                {...(profileErrors ? { errors: profileErrors } : {})}
                {...(avatarError ? { avatarError } : {})}
                {...(profileSuccess ? { successMessage: profileSuccess } : {})}
                {...(profileFormError ? { formError: profileFormError } : {})}
                isSaving={isSavingProfile ?? false}
                isUploadingAvatar={isUploadingAvatar ?? false}
                onChange={(patch) => onProfileChange?.(patch)}
                onAvatarSelect={(file) => onAvatarSelect?.(file)}
                onSubmit={() => onSaveProfile?.()}
                extras={profileExtras}
              />
            )}
            {currentSection === 'email' && sections.includes('email') && (
              <EmailSection
                currentEmail={email}
                value={emailForm}
                {...(emailErrors ? { errors: emailErrors } : {})}
                {...(emailSuccess ? { successMessage: emailSuccess } : {})}
                {...(emailFormError ? { formError: emailFormError } : {})}
                isSaving={isSavingEmail ?? false}
                onChange={(patch) => onEmailChange?.(patch)}
                onSubmit={() => onSaveEmail?.()}
              />
            )}
            {currentSection === 'password' && sections.includes('password') && (
              <PasswordSection
                value={passwordForm}
                {...(passwordErrors ? { errors: passwordErrors } : {})}
                {...(passwordSuccess ? { successMessage: passwordSuccess } : {})}
                {...(passwordFormError ? { formError: passwordFormError } : {})}
                isSaving={isSavingPassword ?? false}
                onChange={(patch) => onPasswordChange?.(patch)}
                onSubmit={() => onSavePassword?.()}
              />
            )}
            {currentSection === 'notifications' && notifications && (
              <NotificationsSection
                value={notifications}
                disabled={notificationsDisabled ?? false}
                {...(notificationsError ? { error: notificationsError } : {})}
                onToggle={(key, checked) => onNotificationToggle?.(key, checked)}
              />
            )}
            {currentSection === 'privacy' && privacy && (
              <PrivacySection
                value={privacy}
                disabled={privacyDisabled ?? false}
                {...(privacyError ? { error: privacyError } : {})}
                onToggle={(key, checked) => onPrivacyToggle?.(key, checked)}
              />
            )}
            {currentSection === 'appearance' && (
              <AppearanceSection
                value={appearance}
                {...(appearanceError ? { error: appearanceError } : {})}
                onChange={(next) => onAppearanceChange?.(next)}
              />
            )}
            {currentSection === 'language' && (
              <LanguageSection
                value={language}
                {...(languageError ? { error: languageError } : {})}
                {...(languageSuccess ? { successMessage: languageSuccess } : {})}
                onChange={(next) => onLanguageChange?.(next)}
              />
            )}
            {currentSection === 'connected' && (
              <ConnectedAccountsSection
                accounts={connectedAccounts}
                isLoading={connectedAccountsLoading ?? false}
                {...(connectedAccountsPendingProvider
                  ? { pendingProvider: connectedAccountsPendingProvider }
                  : {})}
                {...(connectedAccountsError ? { error: connectedAccountsError } : {})}
                onConnect={(provider) => onConnectAccount?.(provider)}
                onDisconnect={(provider) => onDisconnectAccount?.(provider)}
              />
            )}
            {currentSection === 'imports' && (
              <ChannelImportsSection
                providers={channelImportProviders}
                channels={channelImportChannels}
                isLoading={channelImportsLoading ?? false}
                {...(channelImportsPendingProvider
                  ? { pendingProvider: channelImportsPendingProvider }
                  : {})}
                {...(channelImportsAddingPublicYouTube
                  ? { isAddingPublicYouTube: channelImportsAddingPublicYouTube }
                  : {})}
                {...(channelImportsError ? { error: channelImportsError } : {})}
                {...(channelImportsSuccess ? { success: channelImportsSuccess } : {})}
                {...(onRetryChannelImports ? { onRetry: onRetryChannelImports } : {})}
                onConnect={(provider) => onConnectChannelImport?.(provider)}
                {...(onAddPublicYouTubeChannel
                  ? { onAddPublicYouTube: onAddPublicYouTubeChannel }
                  : {})}
                {...(onViewLinkedVideos ? { onViewLinkedVideos } : {})}
              />
            )}
            {currentSection === 'sessions' && sections.includes('sessions') && (
              <SessionsSection
                sessions={sessions}
                isLoading={sessionsLoading ?? false}
                {...(sessionsPendingId ? { pendingSessionId: sessionsPendingId } : {})}
                {...(sessionsError ? { error: sessionsError } : {})}
                empty={sessionsEmpty ?? false}
                onRevoke={(sessionId) => onRevokeSession?.(sessionId)}
              />
            )}
            {currentSection === 'danger' && sections.includes('danger') && (
              <DeleteAccountSection
                value={deleteForm}
                {...(deleteErrors ? { errors: deleteErrors } : {})}
                {...(deleteFormError ? { formError: deleteFormError } : {})}
                isDeleting={isDeletingAccount ?? false}
                onChange={(patch) => onDeleteFormChange?.(patch)}
                onDelete={() => onDeleteAccount?.()}
              />
            )}
          </Section>
        </div>
      </div>
    );

  const page = (
    <Page
      title="Settings"
      description="Manage your account, profile, and preferences."
      containerSize="xl"
    >
      {content}
    </Page>
  );

  return (
    <div data-theme={theme} className={cx(theme === 'dark' && 'dark', className)}>
      {shell ? <AppShell {...shell}>{page}</AppShell> : page}
    </div>
  );
}
