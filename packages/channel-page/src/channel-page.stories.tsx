import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Channel, Playlist, Video } from '@w3ds/types';
import { ChannelPage } from './channel-page';

const channel: Channel = {
  id: 'channel-studio',
  ownerId: 'user-ada',
  handle: 'vidak-studio',
  name: 'Vidak Studio',
  description:
    'Design, engineering, and video production workflows.\n\nNew deep dives every other week, plus shorts covering a single idea at a time.',
  avatarUrl: 'https://images.unsplash.com/photo-1618005198919-d3d4b5a92ead?w=160&h=160&fit=crop',
  subscriberCount: 152_400,
  videoCount: 24,
  createdAt: '2025-01-12T09:00:00.000Z',
};

const bannerChannel: Channel = {
  ...channel,
  bannerUrl: 'https://images.unsplash.com/photo-1522199755839-a2bacb67c546?w=1600&h=400&fit=crop',
};

const baseVideo: Video = {
  id: 'video-design-system',
  channelId: channel.id,
  title: 'Building a practical design system',
  description: 'A tour of the decisions that keep a design system useful as a product grows.',
  thumbnailUrl: 'https://images.unsplash.com/photo-1558655146-d09347e92766?w=1280&h=720&fit=crop',
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

const videos: readonly Video[] = [
  baseVideo,
  {
    ...baseVideo,
    id: 'video-query-caching',
    title: 'Caching server state without surprises',
    thumbnailUrl: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1280&h=720&fit=crop',
    durationSeconds: 518,
    viewCount: 46_110,
  },
  {
    ...baseVideo,
    id: 'video-accessible-player',
    title: 'Accessibility checks for custom video players',
    thumbnailUrl:
      'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1280&h=720&fit=crop',
    durationSeconds: 686,
    viewCount: 21_408,
  },
  {
    ...baseVideo,
    id: 'video-analytics',
    title: 'Making video analytics actionable',
    thumbnailUrl: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1280&h=720&fit=crop',
    durationSeconds: 934,
    viewCount: 12_950,
  },
];

const shorts: readonly Video[] = Array.from({ length: 6 }, (_, index) => ({
  ...baseVideo,
  id: `short-${index}`,
  title: `Design system tip #${index + 1}`,
  thumbnailUrl:
    'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=720&h=1280&fit=crop',
  durationSeconds: 42,
  viewCount: 4_200 * (index + 1),
}));

const playlists: readonly Playlist[] = [
  {
    id: 'playlist-foundations',
    channelId: channel.id,
    title: 'Video platform foundations',
    description: 'The essentials for building a reliable video product.',
    visibility: 'public',
    thumbnailUrl: 'https://images.unsplash.com/photo-1558655146-d09347e92766?w=1280&h=720&fit=crop',
    items: [
      { videoId: 'video-design-system', position: 0, addedAt: '2026-07-14T10:00:00.000Z' },
      { videoId: 'video-query-caching', position: 1, addedAt: '2026-07-14T10:00:00.000Z' },
    ],
    createdAt: '2026-07-14T10:00:00.000Z',
    updatedAt: '2026-07-14T10:00:00.000Z',
  },
  {
    id: 'playlist-accessibility',
    channelId: channel.id,
    title: 'Accessibility in practice',
    description: 'Keyboard, captions, and focus behaviors worth getting right.',
    visibility: 'public',
    thumbnailUrl:
      'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1280&h=720&fit=crop',
    items: [
      { videoId: 'video-accessible-player', position: 0, addedAt: '2026-07-20T10:00:00.000Z' },
    ],
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z',
  },
];

const noop = () => undefined;

const meta = {
  title: 'Pages/Channel page',
  component: ChannelPage,
  parameters: { layout: 'fullscreen' },
  args: {
    channel: bannerChannel,
    isVerified: true,
    videos,
    shorts,
    playlists,
  },
} satisfies Meta<typeof ChannelPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Subscribed: Story = {
  args: { defaultSubscribed: true },
};

export const Unverified: Story = {
  args: { isVerified: false },
};

export const WithoutBanner: Story = {
  args: { channel },
};

export const ShortsTab: Story = {
  args: { activeTab: 'shorts' },
};

export const PlaylistsTab: Story = {
  args: { activeTab: 'playlists', tabs: ['videos', 'shorts', 'playlists', 'about'] },
};

export const AboutTab: Story = {
  args: { activeTab: 'about' },
};

export const MoreVideosAvailable: Story = {
  args: { hasMoreUploads: true },
};

export const FetchingMoreVideos: Story = {
  args: { hasMoreUploads: true, isFetchingMoreUploads: true },
};

export const NoVideos: Story = {
  args: { videos: [], videosState: 'empty' },
};

export const VideosLoading: Story = {
  args: { videosState: 'loading' },
};

export const VideosError: Story = {
  args: { videosState: 'error', onRetryUploads: noop },
};

export const ShortsError: Story = {
  args: { activeTab: 'shorts', shortsState: 'error', onRetryUploads: noop },
};

export const PlaylistsError: Story = {
  args: {
    activeTab: 'playlists',
    playlistsState: 'error',
    onRetryPlaylists: noop,
    tabs: ['videos', 'shorts', 'playlists', 'about'],
  },
};

export const Loading: Story = {
  args: { state: 'loading' },
};

export const Empty: Story = {
  args: { state: 'empty' },
};

export const ErrorState: Story = {
  args: { state: 'error', onRetry: noop },
};

export const Dark: Story = {
  args: { theme: 'dark' },
};
