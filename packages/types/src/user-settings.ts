export type AppearancePreference = 'light' | 'dark' | 'system';

export const appLanguages = ['en', 'es', 'fr', 'de', 'ja', 'pt', 'zh'] as const;
export type AppLanguage = (typeof appLanguages)[number];

export interface NotificationPreferences {
  emailMarketing: boolean;
  emailProductUpdates: boolean;
  emailComments: boolean;
  emailMentions: boolean;
  pushComments: boolean;
  pushMentions: boolean;
  pushSubscriptions: boolean;
}

export interface PrivacySettings {
  showActivityStatus: boolean;
  allowMentions: boolean;
  showSubscriptions: boolean;
  personalizedRecommendations: boolean;
  searchableByEmail: boolean;
}

export interface UserPreferences {
  appearance: AppearancePreference;
  language: AppLanguage;
  notifications: NotificationPreferences;
  privacy: PrivacySettings;
}

export type ConnectedAccountProvider = 'google' | 'github' | 'apple';

export interface ConnectedAccount {
  provider: ConnectedAccountProvider;
  connected: boolean;
  accountLabel?: string;
  connectedAt?: string;
}

export interface AuthDeviceSession {
  id: string;
  deviceName: string;
  location?: string;
  ipAddress?: string;
  lastActiveAt: string;
  createdAt: string;
  current: boolean;
}

export interface UpdateProfileInput {
  displayName: string;
  handle?: string;
  bio?: string;
}

export interface ChangeEmailInput {
  email: string;
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface DeleteAccountInput {
  password: string;
  confirmation: string;
}

export interface UploadAvatarInput {
  name: string;
  size: number;
  type: string;
  /** Preview URL used by the mock client to persist the uploaded avatar. */
  previewUrl: string;
  /** Original image bytes for durable production upload. */
  file?: Blob;
}

export interface UpdateUserPreferencesInput {
  appearance?: AppearancePreference;
  language?: AppLanguage;
  notifications?: Partial<NotificationPreferences>;
  privacy?: Partial<PrivacySettings>;
}

export const defaultNotificationPreferences: NotificationPreferences = {
  emailMarketing: false,
  emailProductUpdates: true,
  emailComments: true,
  emailMentions: true,
  pushComments: true,
  pushMentions: true,
  pushSubscriptions: true,
};

export const defaultPrivacySettings: PrivacySettings = {
  showActivityStatus: true,
  allowMentions: true,
  showSubscriptions: true,
  personalizedRecommendations: true,
  searchableByEmail: false,
};

export const defaultUserPreferences: UserPreferences = {
  appearance: 'system',
  language: 'en',
  notifications: defaultNotificationPreferences,
  privacy: defaultPrivacySettings,
};

export function mergeUserPreferences(
  previous: UserPreferences | undefined,
  input?: UpdateUserPreferencesInput,
): UserPreferences {
  const base = previous ?? defaultUserPreferences;
  if (!input) {
    return {
      appearance: base.appearance,
      language: base.language,
      notifications: { ...base.notifications },
      privacy: { ...base.privacy },
    };
  }
  return {
    appearance: input.appearance ?? base.appearance,
    language: input.language ?? base.language,
    notifications: { ...base.notifications, ...input.notifications },
    privacy: { ...base.privacy, ...input.privacy },
  };
}

/** Shared avatar upload constraints used by clients and settings validation. */
export const supportedAvatarMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const supportedAvatarExtensions = ['.jpg', '.jpeg', '.png', '.webp'] as const;
export const maxAvatarFileSizeBytes = 5 * 1024 * 1024;

/** Exact confirmation token required to delete an account. */
export const deleteAccountConfirmation = 'DELETE';
