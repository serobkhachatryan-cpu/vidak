import type { Channel, Playlist } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ChannelSearchResult,
  PlaylistSearchResult,
  SearchFilters,
  SearchResultSkeleton,
  SearchSortControl,
} from './search-results';

const channel: Channel = {
  id: 'channel-studio',
  ownerId: 'user-ada',
  handle: 'vidak-studio',
  name: 'Vidak Studio',
  subscriberCount: 152_400,
  videoCount: 4,
  createdAt: '2025-01-12T09:00:00.000Z',
};

const playlist: Playlist = {
  id: 'playlist-foundations',
  channelId: channel.id,
  title: 'Video platform foundations',
  visibility: 'public',
  items: [],
  createdAt: '2026-07-14T10:00:00.000Z',
  updatedAt: '2026-07-14T10:00:00.000Z',
};

describe('search result UI', () => {
  it('renders labelled search filters and sort controls', () => {
    const markup = renderToStaticMarkup(
      <>
        <SearchFilters value="videos" onChange={() => undefined} />
        <SearchSortControl value="relevance" onChange={() => undefined} />
      </>,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('Sort by');
  });

  it('renders accessible channel, playlist, and loading results', () => {
    const markup = renderToStaticMarkup(
      <>
        <ChannelSearchResult channel={channel} />
        <PlaylistSearchResult playlist={playlist} />
        <SearchResultSkeleton type="channels" />
      </>,
    );

    expect(markup).toContain('href="/channel/channel-studio"');
    expect(markup).toContain('href="/playlist/playlist-foundations"');
    expect(markup).toContain('aria-label="Loading search result"');
  });
});
