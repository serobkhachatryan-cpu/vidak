import type { Channel, Playlist, Video } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChannelPage } from './channel-page';

const channel: Channel = {
  id: 'channel-studio',
  ownerId: 'user-ada',
  handle: 'vidak-studio',
  name: 'Vidak Studio',
  description: 'Design, engineering, and video production workflows.',
  subscriberCount: 999,
  videoCount: 24,
  createdAt: '2025-01-12T09:00:00.000Z',
};

const channelWithoutDescription: Channel = {
  id: 'channel-quiet',
  ownerId: 'user-ada',
  handle: 'quiet-studio',
  name: 'Quiet Studio',
  subscriberCount: 12,
  videoCount: 0,
  createdAt: '2025-03-04T09:00:00.000Z',
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

const short: Video = {
  ...video,
  id: 'short-tip',
  title: 'Design system tip',
  durationSeconds: 45,
  viewCount: 4_200,
};

const playlist: Playlist = {
  id: 'playlist-foundations',
  channelId: channel.id,
  title: 'Video platform foundations',
  description: 'The essentials for building a reliable video product.',
  visibility: 'public',
  items: [{ videoId: video.id, position: 0, addedAt: '2026-07-14T10:00:00.000Z' }],
  createdAt: '2026-07-14T10:00:00.000Z',
  updatedAt: '2026-07-14T10:00:00.000Z',
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

describe('ChannelPage', () => {
  it('renders the channel identity and subscribe control', () => {
    const markup = renderToStaticMarkup(
      <ChannelPage channel={channel} isVerified videos={[video]} />,
    );

    expect(markup).toContain('aria-label="Vidak Studio channel banner"');
    expect(markup).toContain('<h1');
    expect(markup).toContain('Vidak Studio');
    expect(markup).toContain('aria-label="Verified channel"');
    expect(markup).toContain('@vidak-studio · 999 subscribers · 24 videos');
    expect(markup).toContain('Design, engineering, and video production workflows.');
    expect(markup).toContain('aria-label="Subscribe to Vidak Studio"');
  });

  it('links every tab to its panel with ids scoped to the rendered instance', () => {
    const markup = renderToStaticMarkup(
      <>
        <ChannelPage channel={channel} videos={[video]} />
        <ChannelPage channel={channel} videos={[video]} activeTab="about" />
      </>,
    );
    const tabs = readTabs(markup);

    expect(markup).toContain('aria-label="Channel sections"');
    expect(tabs.map((tab) => tab.label)).toEqual([
      'Videos',
      'Shorts',
      'About',
      'Videos',
      'Shorts',
      'About',
    ]);
    expect(markup).not.toContain('>Playlists<');
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

  it('reuses video cards for the videos tab and links to the channel uploads', () => {
    const markup = renderToStaticMarkup(<ChannelPage channel={channel} videos={[video]} />);

    expect(markup).toContain('aria-label="Watch Building a practical design system"');
    expect(markup).toContain('href="/watch/video-design-system"');
    expect(markup).toContain('12:22');
    expect(markup).toContain('98.3K views');
    expect(markup).not.toContain('aria-label="Verified channel"');
  });

  it('reflects the mock subscription in the button and subscriber count', () => {
    const markup = renderToStaticMarkup(
      <ChannelPage channel={channel} videos={[video]} defaultSubscribed />,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Unsubscribe from Vidak Studio"');
    expect(markup).toContain('Subscribed');
    expect(markup).toContain('1K subscribers');
  });

  it('renders the shorts, playlists, and about tabs', () => {
    const shortsMarkup = renderToStaticMarkup(
      <ChannelPage channel={channel} shorts={[short]} activeTab="shorts" />,
    );
    expect(shortsMarkup).toContain('aria-label="Watch Design system tip"');
    expect(shortsMarkup).toContain('aspect-[9/16]');
    expect(shortsMarkup).toContain('4.2K views');

    const playlistsMarkup = renderToStaticMarkup(
      <ChannelPage
        channel={channel}
        playlists={[playlist]}
        activeTab="playlists"
        tabs={['videos', 'shorts', 'playlists', 'about']}
      />,
    );
    expect(playlistsMarkup).toContain('href="/playlist/playlist-foundations"');
    expect(playlistsMarkup).toContain('Video platform foundations');

    const aboutMarkup = renderToStaticMarkup(<ChannelPage channel={channel} activeTab="about" />);
    expect(aboutMarkup).toContain('aria-label="Channel description"');
    expect(aboutMarkup).toContain('aria-label="Channel details"');
    expect(aboutMarkup).toContain('Joined');
    expect(aboutMarkup).toContain('2025');
  });

  it('falls back to placeholder copy when the channel has no description', () => {
    const markup = renderToStaticMarkup(
      <ChannelPage channel={channelWithoutDescription} activeTab="about" />,
    );

    expect(markup).toContain('This channel has not added a description yet.');
  });

  it('renders channel-level loading, empty, and error states with accessible labels', () => {
    expect(renderToStaticMarkup(<ChannelPage state="loading" />)).toContain(
      'aria-label="Loading channel"',
    );
    expect(renderToStaticMarkup(<ChannelPage state="empty" />)).toContain('Channel unavailable');
    expect(renderToStaticMarkup(<ChannelPage state="error" onRetry={() => undefined} />)).toContain(
      'Could not load this channel',
    );
  });

  it('renders per-tab loading, empty, and error states', () => {
    expect(renderToStaticMarkup(<ChannelPage channel={channel} videosState="loading" />)).toContain(
      'aria-label="Loading videos"',
    );
    expect(renderToStaticMarkup(<ChannelPage channel={channel} videos={[]} />)).toContain(
      'No videos yet',
    );
    expect(
      renderToStaticMarkup(
        <ChannelPage channel={channel} videosState="error" onRetryUploads={() => undefined} />,
      ),
    ).toContain('Could not load videos');

    expect(
      renderToStaticMarkup(
        <ChannelPage channel={channel} activeTab="shorts" shortsState="loading" />,
      ),
    ).toContain('aria-label="Loading shorts"');
    expect(
      renderToStaticMarkup(<ChannelPage channel={channel} activeTab="shorts" shorts={[]} />),
    ).toContain('No shorts yet');
    expect(
      renderToStaticMarkup(
        <ChannelPage
          channel={channel}
          activeTab="shorts"
          shortsState="error"
          onRetryUploads={() => undefined}
        />,
      ),
    ).toContain('Could not load shorts');

    expect(
      renderToStaticMarkup(
        <ChannelPage
          channel={channel}
          activeTab="playlists"
          playlistsState="loading"
          tabs={['videos', 'shorts', 'playlists', 'about']}
        />,
      ),
    ).toContain('aria-label="Loading playlists"');
    expect(
      renderToStaticMarkup(
        <ChannelPage
          channel={channel}
          activeTab="playlists"
          playlists={[]}
          tabs={['videos', 'shorts', 'playlists', 'about']}
        />,
      ),
    ).toContain('No playlists yet');
    expect(
      renderToStaticMarkup(
        <ChannelPage
          channel={channel}
          activeTab="playlists"
          playlistsState="error"
          onRetryPlaylists={() => undefined}
          tabs={['videos', 'shorts', 'playlists', 'about']}
        />,
      ),
    ).toContain('Could not load playlists');
  });

  it('announces each loading section once instead of once per skeleton', () => {
    const markup = renderToStaticMarkup(<ChannelPage channel={channel} videosState="loading" />);

    expect(markup).toContain(
      '<div role="status" aria-live="polite" aria-label="Loading videos"><div aria-hidden="true">',
    );
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it('offers a load more control only when further uploads are available', () => {
    expect(
      renderToStaticMarkup(
        <ChannelPage
          channel={channel}
          videos={[video]}
          hasMoreUploads
          onLoadMoreUploads={() => undefined}
        />,
      ),
    ).toContain('Load more videos');
    expect(renderToStaticMarkup(<ChannelPage channel={channel} videos={[video]} />)).not.toContain(
      'Load more videos',
    );
  });

  it('keeps the load more control busy while the next uploads page is fetching', () => {
    const markup = renderToStaticMarkup(
      <ChannelPage
        channel={channel}
        videos={[video]}
        hasMoreUploads
        isFetchingMoreUploads
        onLoadMoreUploads={() => undefined}
      />,
    );

    expect(markup).toContain('Load more videos');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('disabled=""');
  });

  it('applies responsive layouts and dark mode', () => {
    const markup = renderToStaticMarkup(
      <ChannelPage channel={channel} videos={[video]} theme="dark" />,
    );

    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain('grid-cols-1 sm:grid-cols-2 lg:grid-cols-4');
    expect(markup).toContain('sm:flex-row sm:items-center sm:justify-between');
    expect(markup).toContain('h-28 w-full rounded-xl sm:h-40 lg:h-56');

    expect(
      renderToStaticMarkup(<ChannelPage channel={channel} shorts={[short]} activeTab="shorts" />),
    ).toContain('grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6');
    expect(renderToStaticMarkup(<ChannelPage channel={channel} activeTab="about" />)).toContain(
      'lg:grid-cols-[minmax(0,1fr)_20rem]',
    );
  });
});
