import { getAuthProviderCapabilities } from '@w3ds/auth';
import { defaultNotificationPreferences, defaultPrivacySettings } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './settings-page';
import { readChannelImports } from './settings-page-data';
import { settingsSectionsForCapabilities } from './settings-page-helpers';

const profile = {
  displayName: 'Demo Creator',
  handle: 'demo-creator',
  bio: 'Building on Vidak.',
};

describe('SettingsPage', () => {
  it('renders accessible section navigation for the active settings panel', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
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

  it('opens the Profile panel from defaultSection so /settings?section=profile can land there', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage email="demo@vidak.video" profile={profile} defaultSection="profile" />,
    );
    expect(markup).toContain('Display name');
    expect(markup).toContain('Update how you appear across Vidak.');
    expect(markup).toContain('aria-selected="true"');
  });

  it('surfaces profile validation messaging', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
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
        email="demo@vidak.video"
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
      <SettingsPage email="demo@vidak.video" profile={profile} activeSection="appearance" />,
    );
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('Light');
    expect(markup).toContain('Dark');
    expect(markup).toContain('System');
  });

  it('renders sessions and connected accounts states', () => {
    const sessions = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
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
        email="demo@vidak.video"
        profile={profile}
        activeSection="sessions"
        sessionsEmpty
      />,
    );
    expect(emptySessions).toContain('No active sessions');

    const loadingSessions = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
        profile={profile}
        activeSection="sessions"
        sessionsLoading
      />,
    );
    expect(loadingSessions).toContain('aria-label="Loading sessions"');
    expect(loadingSessions).not.toContain('No active sessions');

    const loadingConnected = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
        profile={profile}
        activeSection="connected"
        connectedAccountsLoading
      />,
    );
    expect(loadingConnected).toContain('aria-label="Loading connected accounts"');
  });

  it('renders channel import controls without claiming provider media is hosted by Vidak', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
        profile={profile}
        activeSection="imports"
        channelImportProviders={[
          { provider: 'youtube', label: 'YouTube', available: true },
          { provider: 'vimeo', label: 'Vimeo', available: false },
        ]}
        onViewLinkedVideos={() => undefined}
        channelImportChannels={[
          {
            id: 'import-1',
            provider: 'youtube',
            access: 'authorised',
            sourceChannelId: 'channel-1',
            title: 'Creator channel',
            sourceUrl: 'https://www.youtube.com/channel/channel-1',
            status: 'ready',
            importedVideoCount: 12,
          },
        ]}
      />,
    );
    expect(markup).toContain('Connect YouTube');
    expect(markup).toContain('Add a public YouTube channel');
    expect(markup).not.toContain('Owner connection unavailable');
    expect(markup).toContain('Creator channel');
    expect(markup).toContain('Videos keep playing from YouTube or Vimeo');
    expect(markup).toContain('12 videos in Vidak');
    expect(markup).toContain('View videos');
  });

  it('hides unavailable owner connections while retaining the public YouTube action', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
        profile={profile}
        activeSection="imports"
        channelImportProviders={[
          { provider: 'youtube', label: 'YouTube', available: false },
          { provider: 'vimeo', label: 'Vimeo', available: false },
        ]}
      />,
    );

    expect(markup).toContain('Add a public YouTube channel');
    expect(markup).toContain('Owner-authorized channel connections are not available right now.');
    expect(markup).not.toContain('Owner connection unavailable');
    expect(markup).not.toContain('aria-label="Available channel providers"');
  });

  it('refreshes a W3DS cookie session before retrying channel imports', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Authentication is required.' } }), {
          status: 401,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [],
            providers: [{ provider: 'youtube', label: 'YouTube', available: true }],
          }),
        ),
      );
    const restoreFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    const getCurrentUser = vi.fn().mockResolvedValue({ id: 'creator' });

    try {
      await expect(readChannelImports({ getCurrentUser }, '')).resolves.toEqual({
        items: [],
        providers: [{ provider: 'youtube', label: 'YouTube', available: true }],
      });
      expect(getCurrentUser).toHaveBeenCalledWith('');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = restoreFetch;
    }
  });

  it('keeps a retry action visible when channel imports cannot load', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
        profile={profile}
        activeSection="imports"
        channelImportsError="Could not load channel imports."
        onRetryChannelImports={() => undefined}
      />,
    );

    expect(markup).toContain('Could not load channel imports.');
    expect(markup).toContain('Try again');
  });

  it('renders email, password, privacy, and language sections', () => {
    const email = renderToStaticMarkup(
      <SettingsPage email="demo@vidak.video" profile={profile} activeSection="email" />,
    );
    expect(email).toContain('demo@vidak.video');

    const password = renderToStaticMarkup(
      <SettingsPage email="demo@vidak.video" profile={profile} activeSection="password" />,
    );
    expect(password).toContain('Current password');
    expect(password).toContain('New password');

    const privacy = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
        profile={profile}
        privacy={defaultPrivacySettings}
        activeSection="privacy"
      />,
    );
    expect(privacy).toContain('role="switch"');
    expect(privacy).toContain('Show activity status');

    const language = renderToStaticMarkup(
      <SettingsPage email="demo@vidak.video" profile={profile} activeSection="language" />,
    );
    expect(language).toContain('English');
    expect(language).toContain('Español');
  });

  it('associates notification switches with visible labels', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
        profile={profile}
        notifications={defaultNotificationPreferences}
        activeSection="notifications"
      />,
    );
    expect(markup).toContain('aria-labelledby=');
    expect(markup).not.toContain('aria-label="Comment emails"');
  });

  it('renders delete account confirmation controls', () => {
    const markup = renderToStaticMarkup(
      <SettingsPage email="demo@vidak.video" profile={profile} activeSection="danger" />,
    );
    expect(markup).toContain('Delete account');
    expect(markup).toContain('Deleting your account removes your profile');
    expect(markup).toContain('aria-describedby=');
  });

  it('hides password and email panels when the W3DS capability matrix is applied', () => {
    const sections = settingsSectionsForCapabilities(getAuthProviderCapabilities('w3ds'));
    const markup = renderToStaticMarkup(
      <SettingsPage
        email="demo@vidak.video"
        profile={profile}
        sections={sections}
        activeSection="profile"
      />,
    );
    expect(markup).not.toContain('>Email<');
    expect(markup).not.toContain('>Password<');
    expect(markup).not.toContain('>Delete account<');
    expect(markup).toContain('>Sessions<');
    expect(markup).toContain('>Profile<');
    expect(markup).toContain('>Appearance<');
  });

  it('renders loading and error states', () => {
    const loading = renderToStaticMarkup(<SettingsPage state="loading" />);
    expect(loading).toContain('aria-label="Loading settings"');

    const error = renderToStaticMarkup(<SettingsPage state="error" onRetry={() => undefined} />);
    expect(error).toContain('Could not load settings');
  });
});
