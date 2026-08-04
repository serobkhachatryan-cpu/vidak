'use client';

import type {
  AppearancePreference,
  AppLanguage,
  AuthDeviceSession,
  ConnectedAccount,
  ConnectedAccountProvider,
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
import { type ReactNode, useId, useState } from 'react';
import { AppearanceSection } from './sections/appearance-section';
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
  type SettingsSectionId,
  settingsNavId,
  settingsPanelId,
  settingsSectionDescriptions,
  settingsSectionLabels,
} from './settings-constants';
import { SettingsNav } from './settings-nav';
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

export type SettingsPageState = 'loading' | 'error' | 'empty' | 'ready';

export interface SettingsPageProps {
  state?: SettingsPageState;
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
  onNotificationToggle?: (key: keyof NotificationPreferences, checked: boolean) => void;
  privacy?: PrivacySettings;
  privacyError?: string;
  onPrivacyToggle?: (key: keyof PrivacySettings, checked: boolean) => void;
  appearance?: AppearancePreference;
  appearanceError?: string;
  onAppearanceChange?: (appearance: AppearancePreference) => void;
  language?: AppLanguage;
  languageError?: string;
  languageSuccess?: string;
  onLanguageChange?: (language: AppLanguage) => void;
  connectedAccounts?: readonly ConnectedAccount[];
  connectedAccountsPendingProvider?: ConnectedAccountProvider;
  connectedAccountsError?: string;
  onConnectAccount?: (provider: ConnectedAccountProvider) => void;
  onDisconnectAccount?: (provider: ConnectedAccountProvider) => void;
  sessions?: readonly AuthDeviceSession[];
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
  onNotificationToggle,
  privacy,
  privacyError,
  onPrivacyToggle,
  appearance = 'system',
  appearanceError,
  onAppearanceChange,
  language = 'en',
  languageError,
  languageSuccess,
  onLanguageChange,
  connectedAccounts = [],
  connectedAccountsPendingProvider,
  connectedAccountsError,
  onConnectAccount,
  onDisconnectAccount,
  sessions = [],
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
  const [selectedSection, setSelectedSection] = useState<SettingsSectionId>(defaultSection);
  const currentSection = activeSection ?? selectedSection;

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
        <SettingsNav scope={scope} activeSection={currentSection} onChange={changeSection} />
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
              />
            )}
            {currentSection === 'email' && (
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
            {currentSection === 'password' && (
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
                {...(notificationsError ? { error: notificationsError } : {})}
                onToggle={(key, checked) => onNotificationToggle?.(key, checked)}
              />
            )}
            {currentSection === 'privacy' && privacy && (
              <PrivacySection
                value={privacy}
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
                {...(connectedAccountsPendingProvider
                  ? { pendingProvider: connectedAccountsPendingProvider }
                  : {})}
                {...(connectedAccountsError ? { error: connectedAccountsError } : {})}
                onConnect={(provider) => onConnectAccount?.(provider)}
                onDisconnect={(provider) => onDisconnectAccount?.(provider)}
              />
            )}
            {currentSection === 'sessions' && (
              <SessionsSection
                sessions={sessions}
                {...(sessionsPendingId ? { pendingSessionId: sessionsPendingId } : {})}
                {...(sessionsError ? { error: sessionsError } : {})}
                empty={sessionsEmpty ?? false}
                onRevoke={(sessionId) => onRevokeSession?.(sessionId)}
              />
            )}
            {currentSection === 'danger' && (
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
