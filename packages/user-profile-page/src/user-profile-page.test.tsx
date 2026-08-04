import type { Channel, Playlist, UserProfile, Video } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UserProfilePage } from './user-profile-page';

const profile: UserProfile = {
  id: 'user-ada',
  handle: 'ada-lovelace',
  displayName: 'Ada Lovelace',
  avatarUrl: 'https://example.com/ada.jpg',
  bio: 'Building thoughtful tools for curious people.',
  location: 'London, United Kingdom',
  websiteUrl: 'https://example.com/ada',
  joinedAt: '2025-01-12T09:00:00.000Z',
  subscriberCount: 999,
  followingCount: 42,
  isVerified: true,
};

const profileWithoutBio: UserProfile = {
  id: 'user-grace',
  handle: 'grace-hopper',
  displayName: 'Grace Hopper',
  joinedAt: '2025-05-20T09:00:00.000Z',
  subscriberCount: 12,
  followingCount: 3,
  isVerified: false,
};

const channel: Channel = {
  id: 'channel-studio',
  ownerId: profile.id,
  handle: 'w3ds-studio',
  name: 'W3DS Studio',
  subscriberCount: 999,
  videoCount: 24,
  createdAt: '2025-01-12T09:00:00.000Z',
};

const video: Video = {
  id: 'video-design-system',
  channelId: channel.id,
  title: 'Building a practical design system',
  description: 'A tour of the decisions that keep a design system useful as a product grows.',
  thumbnailUrl: 'https://example.com/thumbnail.jpg',
  durationSeconds: 742,
  status: 'published',
  visibility: 'public',
  publishedAt: '2026-07-14T10:00:00.000Z',
  createdAt: '2026-07-10T09:30:00.000Z',
  updatedAt: '2026-07-14T10:00:00.000Z',
  viewCount: 98_320,
  likeCount: 8_440,
  commentCount: 3,
  tags: ['design systems', 'frontend'],
};

const playlist: Playlist = {
  id: 'playlist-foundations',
  channelId: channel.id,
  title: 'Video platform foundations',
  description: 'The essentials for building a reliable video product.',
  visibility: 'public',
  thumbnailUrl: 'https://example.com/playlist.jpg',
  items: [{ videoId: video.id, position: 0, addedAt: '2026-07-14T10:00:00.000Z' }],
  createdAt: '2026-07-14T10:00:00.000Z',
  updatedAt: '2026-07-14T10:00:00.000Z',
};

const placeholderPlaylist: Playlist = {
  id: 'playlist-placeholder',
  channelId: channel.id,
  title: 'Untitled playlist',
  visibility: 'public',
  items: [],
  createdAt: '2026-07-20T10:00:00.000Z',
  updatedAt: '2026-07-20T10:00:00.000Z',
};

interface RenderedTab {
  id: string;
  controls: string;
  label: string;
  selected: boolean;
}

function readTabs(markup: string): RenderedTab[] {
  return [...markup.matchAll(/<button([^>]*role="tab"[^>]*)>([^<]*)</g)].map(
    ([, attributes = '', label = '']) => ({
      id: /id="([^"]+)"/.exec(attributes)?.[1] ?? '',
      controls: /aria-controls="([^"]+)"/.exec(attributes)?.[1] ?? '',
      label,
      selected: attributes.includes('aria-selected="true"'),
    }),
  );
}

describe('UserProfilePage', () => {
  it('renders the profile identity, metadata, and actions', () => {
    const markup = renderToStaticMarkup(
      <UserProfilePage profile={profile} videos={[video]} videoCount={24} />,
    );

    expect(markup).toContain('aria-label="Ada Lovelace profile banner"');
    expect(markup).toContain('<h1');
    expect(markup).toContain('Ada Lovelace');
    expect(markup).toContain('aria-label="Verified profile"');
    expect(markup).toContain('@ada-lovelace');
    expect(markup).toContain('999 followers · 42 following · 24 videos');
    expect(markup).toContain('Building thoughtful tools for curious people.');
    expect(markup).toContain('London, United Kingdom');
    expect(markup).toContain('example.com/ada');
    expect(markup).toContain('opens in a new tab');
    expect(markup).toContain('Joined January 2025');
    expect(markup).toContain('aria-label="Follow Ada Lovelace"');
    expect(markup).toContain('aria-label="Share Ada Lovelace&#x27;s profile"');
    expect(markup).toContain('aria-label="More actions for Ada Lovelace"');
  });

  it('links every tab to its panel with ids scoped to the rendered instance', () => {
    const markup = renderToStaticMarkup(
      <>
        <UserProfilePage profile={profile} videos={[video]} />
        <UserProfilePage profile={profile} videos={[video]} activeTab="about" />
      </>,
    );
    const tabs = readTabs(markup);

    expect(markup).toContain('aria-label="Profile sections"');
    expect(tabs.map((tab) => tab.label)).toEqual([
      'Videos',
      'Playlists',
      'About',
      'Videos',
      'Playlists',
      'About',
    ]);
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length);
    expect(new Set(tabs.map((tab) => tab.controls)).size).toBe(tabs.length);

    const selectedTabs = tabs.filter((tab) => tab.selected);
    expect(selectedTabs.map((tab) => tab.label)).toEqual(['Videos', 'About']);
    for (const tab of selectedTabs) {
      expect(markup).toContain(
        `<div role="tabpanel" id="${tab.controls}" aria-labelledby="${tab.id}"`,
      );
    }
  });

  it('reuses video cards for the videos tab with the home-feed grid', () => {
    const markup = renderToStaticMarkup(
      <UserProfilePage
        profile={profile}
        videos={[video]}
        channelsById={{ [channel.id]: channel }}
      />,
    );

    expect(markup).toContain('aria-label="Watch Building a practical design system"');
    expect(markup).toContain('href="/watch/video-design-system"');
    expect(markup).toContain('12:22');
    expect(markup).toContain('98.3K views');
    expect(markup).toContain('grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5');
  });

  it('reflects the mock follow state in the button and follower count', () => {
    const markup = renderToStaticMarkup(
      <UserProfilePage profile={profile} videos={[video]} defaultFollowing />,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Unfollow Ada Lovelace"');
    expect(markup).toContain('Following');
    expect(markup).toContain('1K followers');
  });

  it('renders the playlists and about tabs', () => {
    const playlistsMarkup = renderToStaticMarkup(
      <UserProfilePage
        profile={profile}
        playlists={[playlist, placeholderPlaylist]}
        activeTab="playlists"
      />,
    );
    expect(playlistsMarkup).toContain('href="/playlist/playlist-foundations"');
    expect(playlistsMarkup).toContain('Video platform foundations');
    expect(playlistsMarkup).toContain('aria-label="Playlist Untitled playlist"');

    const aboutMarkup = renderToStaticMarkup(
      <UserProfilePage profile={profile} activeTab="about" videoCount={24} />,
    );
    expect(aboutMarkup).toContain('aria-label="Profile description"');
    expect(aboutMarkup).toContain('aria-label="Profile statistics"');
    expect(aboutMarkup).toContain('opens in a new tab');
    expect(aboutMarkup).toContain('Joined');
    expect(aboutMarkup).toContain('January 2025');
    expect(aboutMarkup).toContain('999 followers');
    expect(aboutMarkup).toContain('42 following');
  });

  it('falls back to placeholder copy when the profile has no bio', () => {
    const markup = renderToStaticMarkup(
      <UserProfilePage profile={profileWithoutBio} activeTab="about" />,
    );

    expect(markup).toContain('This profile has not added a description yet.');
  });

  it('renders profile-level loading, empty, and error states with accessible labels', () => {
    expect(renderToStaticMarkup(<UserProfilePage state="loading" />)).toContain(
      'aria-label="Loading profile"',
    );
    expect(renderToStaticMarkup(<UserProfilePage state="empty" />)).toContain(
      'Profile unavailable',
    );
    expect(
      renderToStaticMarkup(<UserProfilePage state="error" onRetry={() => undefined} />),
    ).toContain('Could not load this profile');
  });

  it('renders per-tab loading, empty, and error states', () => {
    expect(
      renderToStaticMarkup(<UserProfilePage profile={profile} videosState="loading" />),
    ).toContain('aria-label="Loading videos"');
    expect(renderToStaticMarkup(<UserProfilePage profile={profile} videos={[]} />)).toContain(
      'No videos yet',
    );
    expect(
      renderToStaticMarkup(
        <UserProfilePage profile={profile} videosState="error" onRetryVideos={() => undefined} />,
      ),
    ).toContain('Could not load videos');

    expect(
      renderToStaticMarkup(
        <UserProfilePage profile={profile} activeTab="playlists" playlistsState="loading" />,
      ),
    ).toContain('aria-label="Loading playlists"');
    expect(
      renderToStaticMarkup(
        <UserProfilePage profile={profile} activeTab="playlists" playlists={[]} />,
      ),
    ).toContain('No playlists yet');
    expect(
      renderToStaticMarkup(
        <UserProfilePage
          profile={profile}
          activeTab="playlists"
          playlistsState="error"
          onRetryPlaylists={() => undefined}
        />,
      ),
    ).toContain('Could not load playlists');
  });

  it('announces each loading section once instead of once per skeleton', () => {
    const markup = renderToStaticMarkup(
      <UserProfilePage profile={profile} videosState="loading" />,
    );

    expect(markup).toContain(
      '<div role="status" aria-live="polite" aria-label="Loading videos"><div aria-hidden="true">',
    );
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it('offers a load more control only when further videos are available', () => {
    expect(
      renderToStaticMarkup(
        <UserProfilePage
          profile={profile}
          videos={[video]}
          hasMoreVideos
          onLoadMoreVideos={() => undefined}
        />,
      ),
    ).toContain('Load more videos');
    expect(
      renderToStaticMarkup(<UserProfilePage profile={profile} videos={[video]} />),
    ).not.toContain('Load more videos');
  });

  it('keeps the load more control busy while the next videos page is fetching', () => {
    const markup = renderToStaticMarkup(
      <UserProfilePage
        profile={profile}
        videos={[video]}
        hasMoreVideos
        isFetchingMoreVideos
        onLoadMoreVideos={() => undefined}
      />,
    );

    expect(markup).toContain('Load more videos');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
  });

  it('applies responsive layouts and dark mode', () => {
    const markup = renderToStaticMarkup(
      <UserProfilePage profile={profile} videos={[video]} theme="dark" />,
    );

    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain('grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5');
    expect(markup).toContain('sm:flex-row sm:items-start sm:justify-between');
    expect(markup).toContain('h-28 w-full rounded-xl sm:h-40 lg:h-56');
    expect(renderToStaticMarkup(<UserProfilePage profile={profile} activeTab="about" />)).toContain(
      'lg:grid-cols-[minmax(0,1fr)_20rem]',
    );
  });
});
