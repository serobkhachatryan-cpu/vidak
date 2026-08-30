'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VideoApiClient } from '@w3ds/api-client';
import { type AuthClient, AuthenticationError, type AuthUser } from '@w3ds/auth';
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
  ChannelImportProvider,
  ChannelImportProviderStatus,
  ConnectedAccountProvider,
  ImportedChannel,
  NotificationPreferences,
  PrivacySettings,
  UpdateUserPreferencesInput,
  UserProfile,
  UserProfileId,
} from '@w3ds/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SettingsPage,
  type SettingsPageDataOwnedProp,
  type SettingsPageProps,
} from './settings-page';
import {
  authUserFromProductProfile,
  errorMessage,
  profileFormFromCanonical,
  publicHandleOrEmpty,
  resolveSettingsPageState,
  settingsSectionsForCapabilities,
} from './settings-page-helpers';
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

export interface SettingsPageDataProps extends Omit<SettingsPageProps, SettingsPageDataOwnedProp> {
  authClient: AuthClient;
  videoClient: VideoApiClient;
  accessToken: string;
  userId: UserProfileId;
  /** Current auth session user — used to sync profile when AuthClient profile APIs are unavailable. */
  authUser: AuthUser;
  email: string;
  displayName: string;
  avatarUrl?: string;
  onAuthUserUpdate?: (user: AuthUser) => void;
  onAppearancePreferenceChange?: (appearance: AppearancePreference) => void;
  onAccountDeleted?: () => void;
}

function isAuthProfileUnavailable(error: unknown): boolean {
  return (
    error instanceof AuthenticationError &&
    (error.code === 'provider_unavailable' || error.code === 'unsupported_capability')
  );
}

interface ChannelImportsResponse {
  items: readonly ImportedChannel[];
  providers: readonly ChannelImportProviderStatus[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestChannelImports(accessToken: string): Promise<Response> {
  return fetch('/api/channel-imports', {
    cache: 'no-store',
    credentials: 'same-origin',
    ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
  });
}

/**
 * Channel imports use a dedicated API route, so they must explicitly follow
 * the same cookie-refresh path as the platform auth client. Without this,
 * an otherwise signed-in person sees an empty error state after access-cookie
 * expiry instead of the available provider actions.
 */
export async function readChannelImports(
  authClient: Pick<AuthClient, 'getCurrentUser'>,
  accessToken: string,
): Promise<ChannelImportsResponse> {
  let response = await requestChannelImports(accessToken);
  if (response.status === 401) {
    await authClient.getCurrentUser(accessToken);
    response = await requestChannelImports(accessToken);
  }

  const body = (await response.json().catch(() => undefined)) as unknown;
  if (
    !response.ok ||
    !isRecord(body) ||
    !Array.isArray(body.items) ||
    !Array.isArray(body.providers)
  ) {
    throw new Error(readApiError(body, 'Could not load channel imports.'));
  }
  return body as unknown as ChannelImportsResponse;
}

function readApiError(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return fallback;
}

function isProviderAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'accounts.google.com' || url.hostname === 'api.vimeo.com')
    );
  } catch {
    return false;
  }
}

export function SettingsPageData({
  authClient,
  videoClient,
  accessToken,
  userId,
  authUser,
  email,
  displayName,
  avatarUrl: authAvatarUrl,
  onAuthUserUpdate,
  onAppearancePreferenceChange,
  onAccountDeleted,
  defaultSection,
  onSectionChange,
  ...pageProps
}: SettingsPageDataProps) {
  const queryClient = useQueryClient();
  const capabilities = authClient.capabilities;
  const sections = useMemo(() => settingsSectionsForCapabilities(capabilities), [capabilities]);
  const profileQuery = useUserProfile(videoClient, userId);
  const preferencesQuery = useUserPreferences(videoClient, userId);
  const connectedQuery = useConnectedAccounts(videoClient, userId);
  const channelImportsQuery = useQuery({
    queryKey: ['channel-imports', userId],
    queryFn: () => readChannelImports(authClient, accessToken),
    retry: false,
  });
  const refetchChannelImports = channelImportsQuery.refetch;
  const sessionsQuery = useQuery({
    queryKey: settingsQueryKeys.sessions(userId),
    queryFn: (): Promise<readonly AuthDeviceSession[]> => authClient.listSessions(accessToken),
    enabled: capabilities.manageSessions,
  });

  const [profileForm, setProfileForm] = useState<ProfileFormInput>(() =>
    profileFormFromCanonical({
      authDisplayName: displayName,
      authUserId: authUser.id,
      ...(authUser.profile.handle ? { authHandle: authUser.profile.handle } : {}),
    }),
  );
  const [profileErrors, setProfileErrors] = useState<ProfileFormErrors | undefined>();
  const [profileSuccess, setProfileSuccess] = useState<string | undefined>();
  const [profileFormError, setProfileFormError] = useState<string | undefined>();
  const [isSavingAuthProfile, setIsSavingAuthProfile] = useState(false);
  const [avatarError, setAvatarError] = useState<string | undefined>();
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | undefined>();
  const avatarObjectUrlRef = useRef<string | undefined>(undefined);
  const profileHydratedForUserRef = useRef<UserProfileId | undefined>(undefined);
  const lastAuthDisplayNameRef = useRef(displayName);
  const syncedAppearanceRef = useRef<AppearancePreference | undefined>(undefined);

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
  const [pendingChannelImportProvider, setPendingChannelImportProvider] = useState<
    ChannelImportProvider | undefined
  >();
  const [isAddingPublicYouTube, setIsAddingPublicYouTube] = useState(false);
  const [channelImportsError, setChannelImportsError] = useState<string | undefined>();
  const [channelImportsSuccess, setChannelImportsSuccess] = useState<string | undefined>();
  const [activeSettingsSection, setActiveSettingsSection] =
    useState<SettingsPageProps['activeSection']>();

  useEffect(() => {
    if (!defaultSection) return;
    setActiveSettingsSection(defaultSection);
  }, [defaultSection]);

  useEffect(() => {
    const next = profileFormFromCanonical({
      authDisplayName: displayName,
      authUserId: authUser.id,
      ...(authUser.profile.handle ? { authHandle: authUser.profile.handle } : {}),
      ...(profileQuery.data ? { product: profileQuery.data } : {}),
    });
    const authNameChanged = lastAuthDisplayNameRef.current !== displayName;
    lastAuthDisplayNameRef.current = displayName;
    if (profileHydratedForUserRef.current !== userId || authNameChanged) {
      profileHydratedForUserRef.current = userId;
      setProfileForm(next);
      return;
    }
    setProfileForm((current) => ({
      ...current,
      handle: publicHandleOrEmpty(current.handle, authUser.id),
      bio: current.bio || next.bio,
    }));
  }, [authUser.id, authUser.profile.handle, displayName, profileQuery.data, userId]);

  useEffect(() => {
    const appearance = preferencesQuery.data?.appearance;
    if (!appearance || appearance === syncedAppearanceRef.current) return;
    syncedAppearanceRef.current = appearance;
    onAppearancePreferenceChange?.(appearance);
  }, [onAppearancePreferenceChange, preferencesQuery.data?.appearance]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('channelImport');
    if (!result) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('channelImport');
    window.history.replaceState({}, '', url);
    setActiveSettingsSection('imports');
    onSectionChange?.('imports');
    if (result === 'connected') {
      setChannelImportsSuccess('Channel linked. Vidak will show only the channels you approved.');
      void refetchChannelImports();
    } else if (result === 'cancelled') {
      setChannelImportsError('Channel connection was cancelled.');
    } else {
      setChannelImportsError('Could not connect that channel. Please try again.');
    }
  }, [onSectionChange, refetchChannelImports]);

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

  const syncAuthProjection = async (
    input: { displayName: string; avatarUrl?: string | null },
    productProfile: UserProfile,
  ) => {
    try {
      const next = await authClient.updateProfile(accessToken, input);
      onAuthUserUpdate?.(next);
    } catch (error) {
      if (!isAuthProfileUnavailable(error)) throw error;
      onAuthUserUpdate?.(authUserFromProductProfile(authUser, productProfile));
    }
  };

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

  const clearAvatarPreview = () => {
    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current);
      avatarObjectUrlRef.current = undefined;
    }
    setAvatarPreviewUrl(undefined);
  };

  const saveProfile = async () => {
    const errors = validateProfile(profileForm);
    setProfileErrors(errors);
    if (hasProfileErrors(errors)) return;
    setProfileFormError(undefined);
    setProfileSuccess(undefined);
    setIsSavingAuthProfile(true);
    try {
      const displayNameValue = profileForm.displayName.trim();
      const handle = publicHandleOrEmpty(profileForm.handle, authUser.id);
      const nextUser = await authClient.updateProfile(accessToken, {
        displayName: displayNameValue,
      });
      onAuthUserUpdate?.(nextUser);
      if (profileQuery.data || handle || profileForm.bio.trim()) {
        const profile = await updateProfile.mutateAsync({
          displayName: displayNameValue,
          handle,
          bio: profileForm.bio,
        });
        setProfileForm(
          profileFormFromCanonical({
            authDisplayName: nextUser.displayName,
            authUserId: nextUser.id,
            ...(nextUser.profile.handle ? { authHandle: nextUser.profile.handle } : {}),
            product: profile,
          }),
        );
      } else {
        setProfileForm(
          profileFormFromCanonical({
            authDisplayName: nextUser.displayName,
            authUserId: nextUser.id,
            ...(nextUser.profile.handle ? { authHandle: nextUser.profile.handle } : {}),
          }),
        );
      }
      setProfileSuccess('Profile saved.');
    } catch (error) {
      setProfileFormError(errorMessage(error, 'Could not save profile.'));
    } finally {
      setIsSavingAuthProfile(false);
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
      clearAvatarPreview();
      await syncAuthProjection(
        {
          displayName: profile.displayName,
          ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : { avatarUrl: null }),
        },
        profile,
      );
      setProfileSuccess('Avatar updated.');
    } catch (reason) {
      setAvatarError(errorMessage(reason, 'Could not upload avatar.'));
    }
  };

  const saveEmail = () => {
    if (!capabilities.changeEmail) return;
    const errors = validateEmailChange(emailForm);
    setEmailErrors(errors);
    if (hasEmailErrors(errors)) return;
    setEmailFormError(undefined);
    setEmailSuccess(undefined);
    changeEmailMutation.mutate();
  };

  const savePassword = () => {
    if (!capabilities.changePassword) return;
    const errors = validatePasswordChange(passwordForm);
    setPasswordErrors(errors);
    if (hasPasswordErrors(errors)) return;
    setPasswordFormError(undefined);
    setPasswordSuccess(undefined);
    changePasswordMutation.mutate();
  };

  const startChannelImport = async (provider: ChannelImportProvider) => {
    setChannelImportsError(undefined);
    setChannelImportsSuccess(undefined);
    setPendingChannelImportProvider(provider);
    try {
      const response = await fetch('/api/channel-imports/authorize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider }),
      });
      const body = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok || !isRecord(body) || !isProviderAuthorizationUrl(body.authorizationUrl)) {
        throw new Error(readApiError(body, 'Could not start channel import.'));
      }
      window.location.assign(body.authorizationUrl);
    } catch (error) {
      setChannelImportsError(errorMessage(error, 'Could not start channel import.'));
      setPendingChannelImportProvider(undefined);
    }
  };

  const addPublicYouTubeChannel = async (source: string) => {
    setChannelImportsError(undefined);
    setChannelImportsSuccess(undefined);
    setIsAddingPublicYouTube(true);
    try {
      const request = () =>
        fetch('/api/channel-imports/public-youtube', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ source }),
        });
      let response = await request();
      if (response.status === 401) {
        await authClient.getCurrentUser(accessToken);
        response = await request();
      }
      const body = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok)
        throw new Error(readApiError(body, 'Could not add that public YouTube channel.'));
      setChannelImportsSuccess(
        'Public YouTube channel added. Its latest public videos are ready now.',
      );
      await refetchChannelImports();
    } catch (error) {
      setChannelImportsError(errorMessage(error, 'Could not add that public YouTube channel.'));
    } finally {
      setIsAddingPublicYouTube(false);
    }
  };

  const deleteAccount = () => {
    if (!capabilities.deleteAccount) return;
    const errors = validateDeleteAccount(deleteForm);
    setDeleteErrors(errors);
    if (hasDeleteAccountErrors(errors)) return;
    setDeleteFormError(undefined);
    deleteAccountMutation.mutate();
  };

  const patchPreferences = async (
    input: UpdateUserPreferencesInput,
    onFail: (message: string) => void,
    onSuccess?: () => void,
  ) => {
    try {
      await updatePreferences.mutateAsync(input);
      onSuccess?.();
    } catch (error) {
      onFail(errorMessage(error, 'Could not update preferences.'));
    }
  };

  const profile = profileQuery.data;
  const preferences = preferencesQuery.data;
  const resolvedAvatar = avatarPreviewUrl ?? profile?.avatarUrl ?? authAvatarUrl;
  const preferencesPending = updatePreferences.isPending;

  const resolvedActiveSettingsSection = activeSettingsSection ?? pageProps.activeSection;

  return (
    <SettingsPage
      {...pageProps}
      {...(defaultSection ? { defaultSection } : {})}
      {...(resolvedActiveSettingsSection ? { activeSection: resolvedActiveSettingsSection } : {})}
      onSectionChange={(section) => {
        setActiveSettingsSection(section);
        onSectionChange?.(section);
      }}
      sections={sections}
      state={resolveSettingsPageState({
        isPending: profileQuery.isPending || preferencesQuery.isPending,
        error: profileQuery.error ?? preferencesQuery.error,
        hasProfile: Boolean(profile) || Boolean(authUser),
      })}
      email={email}
      profile={profileForm}
      {...(resolvedAvatar ? { avatarUrl: resolvedAvatar } : {})}
      {...(profileErrors ? { profileErrors } : {})}
      {...(avatarError ? { avatarError } : {})}
      {...(profileSuccess ? { profileSuccess } : {})}
      {...(profileFormError ? { profileFormError } : {})}
      isSavingProfile={updateProfile.isPending || isSavingAuthProfile}
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
      notificationsDisabled={preferencesPending}
      privacyDisabled={preferencesPending}
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
        syncedAppearanceRef.current = appearance;
        onAppearancePreferenceChange?.(appearance);
        void patchPreferences({ appearance }, setAppearanceError);
      }}
      onLanguageChange={(language: AppLanguage) => {
        setLanguageError(undefined);
        setLanguageSuccess(undefined);
        void patchPreferences({ language }, setLanguageError, () =>
          setLanguageSuccess('Language updated.'),
        );
      }}
      channelImportProviders={channelImportsQuery.data?.providers ?? []}
      channelImportChannels={channelImportsQuery.data?.items ?? []}
      channelImportsLoading={channelImportsQuery.isPending}
      {...(pendingChannelImportProvider
        ? { channelImportsPendingProvider: pendingChannelImportProvider }
        : {})}
      {...(isAddingPublicYouTube
        ? { channelImportsAddingPublicYouTube: isAddingPublicYouTube }
        : {})}
      {...(channelImportsError
        ? { channelImportsError }
        : channelImportsQuery.error
          ? {
              channelImportsError: errorMessage(
                channelImportsQuery.error,
                'Could not load channel imports.',
              ),
            }
          : {})}
      {...(channelImportsSuccess ? { channelImportsSuccess } : {})}
      onConnectChannelImport={(provider) => {
        void startChannelImport(provider);
      }}
      onAddPublicYouTubeChannel={(source) => {
        void addPublicYouTubeChannel(source);
      }}
      onRetryChannelImports={() => {
        setChannelImportsError(undefined);
        void refetchChannelImports();
      }}
      connectedAccounts={connectedQuery.data ?? []}
      connectedAccountsLoading={connectedQuery.isPending}
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
      sessions={sessionsQuery.data ?? []}
      sessionsLoading={sessionsQuery.isPending}
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
        void refetchChannelImports();
        if (capabilities.manageSessions) void sessionsQuery.refetch();
      }}
    />
  );
}
