'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VideoApiClient } from '@w3ds/api-client';
import { type AuthApi, AuthenticationError, type AuthUser } from '@w3ds/auth';
import {
  settingsQueryKeys,
  useConnectAccount,
  useConnectedAccounts,
  useDisconnectAccount,
  useUpdateUserPreferences,
  useUpdateUserProfile,
  useUploadUserAvatar,
  useUserPreferences,
  useUserProfile,
} from '@w3ds/hooks';
import type {
  AppearancePreference,
  AppLanguage,
  AuthDeviceSession,
  ConnectedAccountProvider,
  NotificationPreferences,
  PrivacySettings,
  UserProfileId,
} from '@w3ds/types';
import { useEffect, useRef, useState } from 'react';
import { SettingsPage, type SettingsPageProps } from './settings-page';
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
import {
  hasDeleteAccountErrors,
  hasEmailErrors,
  hasPasswordErrors,
  hasProfileErrors,
  validateAvatarFile,
  validateDeleteAccount,
  validateEmailChange,
  validatePasswordChange,
  validateProfile,
} from './settings-validation';

export interface SettingsPageDataProps
  extends Omit<
    SettingsPageProps,
    | 'state'
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
    | 'onNotificationToggle'
    | 'privacy'
    | 'privacyError'
    | 'onPrivacyToggle'
    | 'appearance'
    | 'appearanceError'
    | 'onAppearanceChange'
    | 'language'
    | 'languageError'
    | 'languageSuccess'
    | 'onLanguageChange'
    | 'connectedAccounts'
    | 'connectedAccountsPendingProvider'
    | 'connectedAccountsError'
    | 'onConnectAccount'
    | 'onDisconnectAccount'
    | 'sessions'
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
    | 'onRetry'
  > {
  authClient: AuthApi;
  videoClient: VideoApiClient;
  accessToken: string;
  userId: UserProfileId;
  email: string;
  displayName: string;
  avatarUrl?: string;
  onAuthUserUpdate?: (user: AuthUser) => void;
  onAppearancePreferenceChange?: (appearance: AppearancePreference) => void;
  onAccountDeleted?: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthenticationError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export function SettingsPageData({
  authClient,
  videoClient,
  accessToken,
  userId,
  email,
  displayName,
  avatarUrl: authAvatarUrl,
  onAuthUserUpdate,
  onAppearancePreferenceChange,
  onAccountDeleted,
  ...pageProps
}: SettingsPageDataProps) {
  const queryClient = useQueryClient();
  const profileQuery = useUserProfile(videoClient, userId);
  const preferencesQuery = useUserPreferences(videoClient, userId);
  const connectedQuery = useConnectedAccounts(videoClient, userId);
  const sessionsQuery = useQuery({
    queryKey: settingsQueryKeys.sessions(userId),
    queryFn: () => authClient.listSessions(accessToken),
  });

  const [profileForm, setProfileForm] = useState<ProfileFormInput>({
    displayName,
    handle: '',
    bio: '',
  });
  const [profileErrors, setProfileErrors] = useState<ProfileFormErrors | undefined>();
  const [profileSuccess, setProfileSuccess] = useState<string | undefined>();
  const [profileFormError, setProfileFormError] = useState<string | undefined>();
  const [avatarError, setAvatarError] = useState<string | undefined>();
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | undefined>();
  const avatarObjectUrlRef = useRef<string | undefined>(undefined);

  const [emailForm, setEmailForm] = useState<EmailFormInput>({ email: '', password: '' });
  const [emailErrors, setEmailErrors] = useState<EmailFormErrors | undefined>();
  const [emailSuccess, setEmailSuccess] = useState<string | undefined>();
  const [emailFormError, setEmailFormError] = useState<string | undefined>();

  const [passwordForm, setPasswordForm] = useState<PasswordFormInput>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [passwordErrors, setPasswordErrors] = useState<PasswordFormErrors | undefined>();
  const [passwordSuccess, setPasswordSuccess] = useState<string | undefined>();
  const [passwordFormError, setPasswordFormError] = useState<string | undefined>();

  const [deleteForm, setDeleteForm] = useState<DeleteAccountFormInput>({
    password: '',
    confirmation: '',
  });
  const [deleteErrors, setDeleteErrors] = useState<DeleteAccountFormErrors | undefined>();
  const [deleteFormError, setDeleteFormError] = useState<string | undefined>();

  const [notificationsError, setNotificationsError] = useState<string | undefined>();
  const [privacyError, setPrivacyError] = useState<string | undefined>();
  const [appearanceError, setAppearanceError] = useState<string | undefined>();
  const [languageError, setLanguageError] = useState<string | undefined>();
  const [languageSuccess, setLanguageSuccess] = useState<string | undefined>();
  const [connectedAccountsError, setConnectedAccountsError] = useState<string | undefined>();
  const [sessionsError, setSessionsError] = useState<string | undefined>();
  const [pendingSessionId, setPendingSessionId] = useState<string | undefined>();
  const [pendingProvider, setPendingProvider] = useState<ConnectedAccountProvider | undefined>();

  useEffect(() => {
    const profile = profileQuery.data;
    if (!profile) return;
    setProfileForm({
      displayName: profile.displayName,
      handle: profile.handle,
      bio: profile.bio ?? '',
    });
  }, [profileQuery.data]);

  useEffect(() => {
    const appearance = preferencesQuery.data?.appearance;
    if (appearance) onAppearancePreferenceChange?.(appearance);
  }, [onAppearancePreferenceChange, preferencesQuery.data?.appearance]);

  useEffect(() => {
    return () => {
      if (avatarObjectUrlRef.current) URL.revokeObjectURL(avatarObjectUrlRef.current);
    };
  }, []);

  const updatePreferences = useUpdateUserPreferences(videoClient, userId);
  const updateProfile = useUpdateUserProfile(videoClient, userId);
  const uploadAvatar = useUploadUserAvatar(videoClient, userId);
  const connectAccount = useConnectAccount(videoClient, userId);
  const disconnectAccount = useDisconnectAccount(videoClient, userId);

  const changeEmailMutation = useMutation({
    mutationFn: () => authClient.changeEmail(accessToken, emailForm),
    onSuccess: (user) => {
      onAuthUserUpdate?.(user);
      setEmailForm({ email: '', password: '' });
      setEmailErrors(undefined);
      setEmailFormError(undefined);
      setEmailSuccess('Email updated successfully.');
    },
    onError: (error) => {
      setEmailSuccess(undefined);
      setEmailFormError(errorMessage(error, 'Could not update email.'));
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: () =>
      authClient.changePassword(accessToken, {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      }),
    onSuccess: () => {
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPasswordErrors(undefined);
      setPasswordFormError(undefined);
      setPasswordSuccess('Password updated successfully.');
    },
    onError: (error) => {
      setPasswordSuccess(undefined);
      setPasswordFormError(errorMessage(error, 'Could not update password.'));
    },
  });

  const revokeSessionMutation = useMutation({
    mutationFn: (sessionId: string) => authClient.revokeSession(accessToken, sessionId),
    onMutate: (sessionId) => {
      setPendingSessionId(sessionId);
      setSessionsError(undefined);
    },
    onSuccess: (sessions) => {
      queryClient.setQueryData(settingsQueryKeys.sessions(userId), sessions);
    },
    onError: (error) => {
      setSessionsError(errorMessage(error, 'Could not revoke session.'));
    },
    onSettled: () => setPendingSessionId(undefined),
  });

  const deleteAccountMutation = useMutation({
    mutationFn: () => authClient.deleteAccount(accessToken, deleteForm),
    onSuccess: () => {
      onAccountDeleted?.();
    },
    onError: (error) => {
      setDeleteFormError(errorMessage(error, 'Could not delete account.'));
    },
  });

  const saveProfile = async () => {
    const errors = validateProfile(profileForm);
    setProfileErrors(errors);
    if (hasProfileErrors(errors)) return;
    setProfileFormError(undefined);
    setProfileSuccess(undefined);
    try {
      const profile = await updateProfile.mutateAsync({
        displayName: profileForm.displayName.trim(),
        handle: profileForm.handle.trim().replace(/^@/, '').toLocaleLowerCase(),
        bio: profileForm.bio,
      });
      const authUser = await authClient.updateProfile(accessToken, {
        displayName: profile.displayName,
        ...(profile.avatarUrl
          ? { avatarUrl: profile.avatarUrl }
          : authAvatarUrl
            ? { avatarUrl: null }
            : {}),
      });
      onAuthUserUpdate?.(authUser);
      setProfileSuccess('Profile saved.');
    } catch (error) {
      setProfileFormError(errorMessage(error, 'Could not save profile.'));
    }
  };

  const onAvatarSelect = async (file: File) => {
    const error = validateAvatarFile(file);
    setAvatarError(error);
    if (error) return;
    if (avatarObjectUrlRef.current) URL.revokeObjectURL(avatarObjectUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    avatarObjectUrlRef.current = previewUrl;
    setAvatarPreviewUrl(previewUrl);
    try {
      const profile = await uploadAvatar.mutateAsync({
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl,
      });
      const authUser = await authClient.updateProfile(accessToken, {
        displayName: profile.displayName,
        ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : { avatarUrl: null }),
      });
      onAuthUserUpdate?.(authUser);
      setProfileSuccess('Avatar updated.');
    } catch (reason) {
      setAvatarError(errorMessage(reason, 'Could not upload avatar.'));
    }
  };

  const saveEmail = () => {
    const errors = validateEmailChange(emailForm);
    setEmailErrors(errors);
    if (hasEmailErrors(errors)) return;
    setEmailFormError(undefined);
    setEmailSuccess(undefined);
    changeEmailMutation.mutate();
  };

  const savePassword = () => {
    const errors = validatePasswordChange(passwordForm);
    setPasswordErrors(errors);
    if (hasPasswordErrors(errors)) return;
    setPasswordFormError(undefined);
    setPasswordSuccess(undefined);
    changePasswordMutation.mutate();
  };

  const deleteAccount = () => {
    const errors = validateDeleteAccount(deleteForm);
    setDeleteErrors(errors);
    if (hasDeleteAccountErrors(errors)) return;
    setDeleteFormError(undefined);
    deleteAccountMutation.mutate();
  };

  const patchPreferences = async (
    input: Parameters<typeof updatePreferences.mutateAsync>[0],
    onFail: (message: string) => void,
  ) => {
    try {
      await updatePreferences.mutateAsync(input);
    } catch (error) {
      onFail(errorMessage(error, 'Could not update preferences.'));
    }
  };

  const isLoading = profileQuery.isPending || preferencesQuery.isPending;
  const hasError = Boolean(profileQuery.error || preferencesQuery.error);
  const profile = profileQuery.data;
  const preferences = preferencesQuery.data;
  const resolvedAvatar = avatarPreviewUrl ?? profile?.avatarUrl ?? authAvatarUrl;

  return (
    <SettingsPage
      {...pageProps}
      state={isLoading ? 'loading' : hasError ? 'error' : profile ? 'ready' : 'empty'}
      email={email}
      profile={profileForm}
      {...(resolvedAvatar ? { avatarUrl: resolvedAvatar } : {})}
      {...(profileErrors ? { profileErrors } : {})}
      {...(avatarError ? { avatarError } : {})}
      {...(profileSuccess ? { profileSuccess } : {})}
      {...(profileFormError ? { profileFormError } : {})}
      isSavingProfile={updateProfile.isPending}
      isUploadingAvatar={uploadAvatar.isPending}
      onProfileChange={(patch) => {
        setProfileForm((current) => ({ ...current, ...patch }));
        setProfileSuccess(undefined);
      }}
      onAvatarSelect={(file) => {
        void onAvatarSelect(file);
      }}
      onSaveProfile={() => {
        void saveProfile();
      }}
      emailForm={emailForm}
      {...(emailErrors ? { emailErrors } : {})}
      {...(emailSuccess ? { emailSuccess } : {})}
      {...(emailFormError ? { emailFormError } : {})}
      isSavingEmail={changeEmailMutation.isPending}
      onEmailChange={(patch) => {
        setEmailForm((current) => ({ ...current, ...patch }));
        setEmailSuccess(undefined);
      }}
      onSaveEmail={saveEmail}
      passwordForm={passwordForm}
      {...(passwordErrors ? { passwordErrors } : {})}
      {...(passwordSuccess ? { passwordSuccess } : {})}
      {...(passwordFormError ? { passwordFormError } : {})}
      isSavingPassword={changePasswordMutation.isPending}
      onPasswordChange={(patch) => {
        setPasswordForm((current) => ({ ...current, ...patch }));
        setPasswordSuccess(undefined);
      }}
      onSavePassword={savePassword}
      {...(preferences
        ? {
            notifications: preferences.notifications,
            privacy: preferences.privacy,
            appearance: preferences.appearance,
            language: preferences.language,
          }
        : {})}
      {...(notificationsError ? { notificationsError } : {})}
      {...(privacyError ? { privacyError } : {})}
      {...(appearanceError ? { appearanceError } : {})}
      {...(languageError ? { languageError } : {})}
      {...(languageSuccess ? { languageSuccess } : {})}
      onNotificationToggle={(key: keyof NotificationPreferences, checked) => {
        setNotificationsError(undefined);
        void patchPreferences({ notifications: { [key]: checked } }, setNotificationsError);
      }}
      onPrivacyToggle={(key: keyof PrivacySettings, checked) => {
        setPrivacyError(undefined);
        void patchPreferences({ privacy: { [key]: checked } }, setPrivacyError);
      }}
      onAppearanceChange={(appearance: AppearancePreference) => {
        setAppearanceError(undefined);
        onAppearancePreferenceChange?.(appearance);
        void patchPreferences({ appearance }, setAppearanceError);
      }}
      onLanguageChange={(language: AppLanguage) => {
        setLanguageError(undefined);
        setLanguageSuccess(undefined);
        void updatePreferences
          .mutateAsync({ language })
          .then(() => setLanguageSuccess('Language updated.'))
          .catch((error) => setLanguageError(errorMessage(error, 'Could not update preferences.')));
      }}
      connectedAccounts={connectedQuery.data ?? []}
      {...(pendingProvider ? { connectedAccountsPendingProvider: pendingProvider } : {})}
      {...(connectedAccountsError ? { connectedAccountsError } : {})}
      onConnectAccount={(provider) => {
        setConnectedAccountsError(undefined);
        setPendingProvider(provider);
        connectAccount.mutate(provider, {
          onError: (error) =>
            setConnectedAccountsError(errorMessage(error, 'Could not connect account.')),
          onSettled: () => setPendingProvider(undefined),
        });
      }}
      onDisconnectAccount={(provider) => {
        setConnectedAccountsError(undefined);
        setPendingProvider(provider);
        disconnectAccount.mutate(provider, {
          onError: (error) =>
            setConnectedAccountsError(errorMessage(error, 'Could not disconnect account.')),
          onSettled: () => setPendingProvider(undefined),
        });
      }}
      sessions={(sessionsQuery.data as readonly AuthDeviceSession[] | undefined) ?? []}
      {...(pendingSessionId ? { sessionsPendingId: pendingSessionId } : {})}
      {...(sessionsError ? { sessionsError } : {})}
      sessionsEmpty={!sessionsQuery.isPending && (sessionsQuery.data?.length ?? 0) === 0}
      onRevokeSession={(sessionId) => revokeSessionMutation.mutate(sessionId)}
      deleteForm={deleteForm}
      {...(deleteErrors ? { deleteErrors } : {})}
      {...(deleteFormError ? { deleteFormError } : {})}
      isDeletingAccount={deleteAccountMutation.isPending}
      onDeleteFormChange={(patch) => setDeleteForm((current) => ({ ...current, ...patch }))}
      onDeleteAccount={deleteAccount}
      onRetry={() => {
        void profileQuery.refetch();
        void preferencesQuery.refetch();
        void connectedQuery.refetch();
        void sessionsQuery.refetch();
      }}
    />
  );
}
