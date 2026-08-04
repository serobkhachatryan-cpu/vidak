import type { Meta, StoryObj } from '@storybook/react-vite';
import { defaultNotificationPreferences, defaultPrivacySettings } from '@w3ds/types';
import { SettingsPage } from './settings-page';

const profile = {
  displayName: 'Demo Creator',
  handle: 'demo-creator',
  bio: 'Demo account for exploring W3DS Video settings and creator tools.',
};

const connectedAccounts = [
  {
    provider: 'google' as const,
    connected: true,
    accountLabel: 'demo@gmail.com',
    connectedAt: '2025-06-12T10:00:00.000Z',
  },
  { provider: 'github' as const, connected: false },
  { provider: 'apple' as const, connected: false },
];

const sessions = [
  {
    id: 'session-1',
    deviceName: 'Chrome on macOS',
    location: 'San Francisco, US',
    ipAddress: '203.0.113.10',
    lastActiveAt: '2026-08-04T10:00:00.000Z',
    createdAt: '2026-08-01T09:00:00.000Z',
    current: true,
  },
  {
    id: 'session-2',
    deviceName: 'Safari on iPhone',
    location: 'London, UK',
    ipAddress: '203.0.113.22',
    lastActiveAt: '2026-08-03T18:30:00.000Z',
    createdAt: '2026-07-20T12:00:00.000Z',
    current: false,
  },
];

const meta = {
  title: 'Pages/Settings page',
  component: SettingsPage,
  parameters: { layout: 'fullscreen' },
  args: {
    state: 'ready',
    email: 'demo@w3ds.video',
    profile,
    avatarUrl: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=160&h=160&fit=crop',
    notifications: defaultNotificationPreferences,
    privacy: defaultPrivacySettings,
    appearance: 'system',
    language: 'en',
    connectedAccounts,
    sessions,
    onProfileChange: () => undefined,
    onAvatarSelect: () => undefined,
    onSaveProfile: () => undefined,
    onEmailChange: () => undefined,
    onSaveEmail: () => undefined,
    onPasswordChange: () => undefined,
    onSavePassword: () => undefined,
    onNotificationToggle: () => undefined,
    onPrivacyToggle: () => undefined,
    onAppearanceChange: () => undefined,
    onLanguageChange: () => undefined,
    onConnectAccount: () => undefined,
    onDisconnectAccount: () => undefined,
    onRevokeSession: () => undefined,
    onDeleteFormChange: () => undefined,
    onDeleteAccount: () => undefined,
  },
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProfileReady: Story = {};

export const ProfileInvalid: Story = {
  args: {
    profileErrors: {
      displayName: 'Display name is required.',
      handle: 'Username must be 3–30 characters and use letters, numbers, underscores, or hyphens.',
    },
    profile: { displayName: '', handle: 'x', bio: '' },
  },
};

export const Notifications: Story = {
  args: { activeSection: 'notifications' },
};

export const Appearance: Story = {
  args: { activeSection: 'appearance', appearance: 'dark' },
};

export const ConnectedAccounts: Story = {
  args: { activeSection: 'connected' },
};

export const Sessions: Story = {
  args: { activeSection: 'sessions' },
};

export const DeleteAccount: Story = {
  args: {
    activeSection: 'danger',
    deleteForm: { password: '', confirmation: '' },
  },
};

export const Loading: Story = {
  args: { state: 'loading' },
};

export const LoadError: Story = {
  args: {
    state: 'error',
    onRetry: () => undefined,
  },
};

export const Empty: Story = {
  args: { state: 'empty' },
};

export const DarkTheme: Story = {
  args: { theme: 'dark', activeSection: 'appearance', appearance: 'dark' },
};
