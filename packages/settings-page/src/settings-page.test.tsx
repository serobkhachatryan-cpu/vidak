import { defaultNotificationPreferences, defaultPrivacySettings } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from './settings-page';

const profile = {
  displayName: 'Demo Creator',
  handle: 'demo-creator',
  bio: 'Building on W3DS Video.',
};

describe('SettingsPage', () => {
  it('renders accessible section navigation for the active settings panel', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@w3ds.video"
        profile={profile}
        notifications={defaultNotificationPreferences}
        privacy={defaultPrivacySettings}
        activeSection="profile"
      />,
    );
    expect(markup).toContain('aria-label="Settings sections"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('Display name');
    expect(markup).toContain('Username');
    expect(markup).toContain('Bio');
  });

  it('surfaces profile validation messaging', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@w3ds.video"
        profile={{ displayName: '', handle: '', bio: '' }}
        profileErrors={{
          displayName: 'Display name is required.',
          handle: 'Username is required.',
        }}
        activeSection="profile"
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Display name is required.');
    expect(markup).toContain('Username is required.');
    expect(markup).toContain('aria-invalid="true"');
  });

  it('renders notification preference switches', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@w3ds.video"
        profile={profile}
        notifications={defaultNotificationPreferences}
        activeSection="notifications"
      />,
    );
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('Comment emails');
    expect(markup).toContain('Subscription push notifications');
  });

  it('renders appearance options including system preference', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage email="demo@w3ds.video" profile={profile} activeSection="appearance" />,
    );
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('Light');
    expect(markup).toContain('Dark');
    expect(markup).toContain('System');
  });

  it('renders sessions and connected accounts states', () => {
    const sessions = renderToStaticMarkup(
      <SettingsPage
        email="demo@w3ds.video"
        profile={profile}
        activeSection="sessions"
        sessions={[
          {
            id: 'session-1',
            deviceName: 'Chrome on macOS',
            lastActiveAt: '2026-08-04T10:00:00.000Z',
            createdAt: '2026-08-01T09:00:00.000Z',
            current: true,
          },
        ]}
      />,
    );
    expect(sessions).toContain('Chrome on macOS');
    expect(sessions).toContain('This device');

    const emptySessions = renderToStaticMarkup(
      <SettingsPage
        email="demo@w3ds.video"
        profile={profile}
        activeSection="sessions"
        sessionsEmpty
      />,
    );
    expect(emptySessions).toContain('No active sessions');
  });

  it('renders delete account confirmation controls', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage email="demo@w3ds.video" profile={profile} activeSection="danger" />,
    );
    expect(markup).toContain('Delete account');
    expect(markup).toContain('Deleting your account removes your profile');
  });

  it('renders loading and error states', () => {
    const loading = renderToStaticMarkup(<SettingsPage state="loading" />);
    expect(loading).toContain('aria-label="Loading settings"');

    const error = renderToStaticMarkup(<SettingsPage state="error" onRetry={() => undefined} />);
    expect(error).toContain('Could not load settings');
  });
});
