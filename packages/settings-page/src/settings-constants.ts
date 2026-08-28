import type { AppearancePreference, AppLanguage, ConnectedAccountProvider } from '@w3ds/types';
import {
  deleteAccountConfirmation as sharedDeleteAccountConfirmation,
  maxAvatarFileSizeBytes as sharedMaxAvatarFileSizeBytes,
  supportedAvatarExtensions as sharedSupportedAvatarExtensions,
  supportedAvatarMimeTypes as sharedSupportedAvatarMimeTypes,
} from '@w3ds/types';

export type SettingsPageState = 'loading' | 'error' | 'empty' | 'ready';

export const settingsSectionOrder = [
  'profile',
  'email',
  'password',
  'notifications',
  'privacy',
  'appearance',
  'language',
  'connected',
  'imports',
  'sessions',
  'danger',
] as const;

export type SettingsSectionId = (typeof settingsSectionOrder)[number];

export const settingsSectionLabels: Record<SettingsSectionId, string> = {
  profile: 'Profile',
  email: 'Email',
  password: 'Password',
  notifications: 'Notifications',
  privacy: 'Privacy',
  appearance: 'Appearance',
  language: 'Language',
  connected: 'Sign-in accounts',
  imports: 'External video channels',
  sessions: 'Sessions',
  danger: 'Delete account',
};

export const settingsSectionDescriptions: Record<SettingsSectionId, string> = {
  profile: 'Update how you appear across Vidak.',
  email: 'Manage the email address used to sign in.',
  password: 'Change your password to keep your account secure.',
  notifications: 'Choose which updates you want to receive.',
  privacy: 'Control what others can see about your activity.',
  appearance: 'Choose light, dark, or match your system.',
  language: 'Select the language used across the product.',
  connected: 'Optional ways to sign in with Google, GitHub, or Apple. These do not import video.',
  imports:
    'Optional links to public YouTube or owner-authorized YouTube and Vimeo channels. Vidak does not copy their media.',
  sessions: 'Review devices that are currently signed in.',
  danger: 'Permanently delete your account and creator data.',
};

export const appearanceOptions: readonly {
  value: AppearancePreference;
  label: string;
  description: string;
}[] = [
  { value: 'light', label: 'Light', description: 'Bright surfaces and dark text.' },
  { value: 'dark', label: 'Dark', description: 'Dim surfaces for low-light viewing.' },
  { value: 'system', label: 'System', description: 'Match your device preference.' },
];

export const appLanguageLabels: Record<AppLanguage, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ja: '日本語',
  pt: 'Português',
  zh: '中文',
};

export const connectedAccountLabels: Record<ConnectedAccountProvider, string> = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
};

export const notificationPreferenceLabels = {
  emailMarketing: 'Marketing emails',
  emailProductUpdates: 'Product update emails',
  emailComments: 'Comment emails',
  emailMentions: 'Mention emails',
  pushComments: 'Comment push notifications',
  pushMentions: 'Mention push notifications',
  pushSubscriptions: 'Subscription push notifications',
} as const;

export const privacySettingLabels = {
  showActivityStatus: 'Show activity status',
  allowMentions: 'Allow mentions',
  showSubscriptions: 'Show subscriptions publicly',
  personalizedRecommendations: 'Personalized recommendations',
  searchableByEmail: 'Allow people to find you by email',
} as const;

export const supportedAvatarMimeTypes = sharedSupportedAvatarMimeTypes;
export const supportedAvatarExtensions = sharedSupportedAvatarExtensions;
export const maxAvatarFileSizeBytes = sharedMaxAvatarFileSizeBytes;
export const avatarFileAccept = [...supportedAvatarMimeTypes, ...supportedAvatarExtensions].join(
  ',',
);
export const deleteAccountConfirmation = sharedDeleteAccountConfirmation;

export const settingsNavId = (scope: string, section: SettingsSectionId) =>
  `${scope}-nav-${section}`;
export const settingsPanelId = (scope: string, section: SettingsSectionId) =>
  `${scope}-panel-${section}`;
