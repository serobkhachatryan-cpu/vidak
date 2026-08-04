import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Channel, Playlist } from '@w3ds/types';
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
  handle: 'w3ds-studio',
  name: 'W3DS Studio',
  description: 'Design, engineering, and video production workflows.',
  subscriberCount: 152_400,
  videoCount: 4,
  createdAt: '2025-01-12T09:00:00.000Z',
};

const playlist: Playlist = {
  id: 'playlist-foundations',
  channelId: channel.id,
  title: 'Video platform foundations',
  description: 'The essentials for building a reliable video product.',
  visibility: 'public',
  items: [],
  createdAt: '2026-07-14T10:00:00.000Z',
  updatedAt: '2026-07-14T10:00:00.000Z',
};

const meta = {
  title: 'Domain/Search results',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Filters: Story = {
  render: () => <SearchFilters value="videos" onChange={() => undefined} />,
};

export const Sort: Story = {
  render: () => <SearchSortControl value="relevance" onChange={() => undefined} />,
};

export const ChannelResult: Story = {
  render: () => <ChannelSearchResult channel={channel} />,
};

export const PlaylistResult: Story = {
  render: () => <PlaylistSearchResult playlist={playlist} />,
};

export const Loading: Story = {
  render: () => <SearchResultSkeleton />,
};
