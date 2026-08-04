import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Channel, Playlist, UserProfile, Video } from '@w3ds/types';
import { UserProfilePage } from './user-profile-page';

const profile: UserProfile = {
  id: 'user-ada',
  handle: 'ada-lovelace',
  displayName: 'Ada Lovelace',
  avatarUrl: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=160&h=160&fit=crop',
  bio: 'Building thoughtful tools for curious people.',
  location: 'London, United Kingdom',
  websiteUrl: 'https://example.com/ada',
  joinedAt: '2025-01-12T09:00:00.000Z',
  subscriberCount: 152_400,
  followingCount: 184,
  isVerified: true,
};

const bannerProfile: UserProfile = {
  ...profile,
  bannerUrl: 'https://images.unsplash.com/photo-1522252234503-e356532cafd5?w=1600&h=400&fit=crop',
};

const channel: Channel = {
  id: 'channel-studio',
  ownerId: profile.id,
  handle: 'w3ds-studio',
  name: 'W3DS Studio',
  description: 'Design, engineering, and video production workflows.',
  avatarUrl: 'https://images.unsplash.com/photo-1618005198919-d3d4b5a92ead?w=160&h=160&fit=crop',
  subscriberCount: 152_400,
  videoCount: 4,
  createdAt: '2025-01-12T09:00:00.000Z',
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
    id: 'playlist-placeholder',
    channelId: channel.id,
    title: 'Untitled playlist',
    visibility: 'public',
    items: [],
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z',
  },
];

const noop = () => undefined;

const meta = {
  title: 'Pages/User profile page',
  component: UserProfilePage,
  parameters: { layout: 'fullscreen' },
  args: {
    profile: bannerProfile,
    videos,
    channelsById: { [channel.id]: channel },
    playlists,
    videoCount: 4,
  },
} satisfies Meta<typeof UserProfilePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Following: Story = { args: { defaultFollowing: true } };
export const Unverified: Story = {
  args: { profile: { ...bannerProfile, isVerified: false } },
};
export const WithoutBanner: Story = { args: { profile } };
export const PlaylistsTab: Story = { args: { activeTab: 'playlists' } };
export const AboutTab: Story = { args: { activeTab: 'about' } };
export const MoreVideosAvailable: Story = {
  args: { hasMoreVideos: true, onLoadMoreVideos: noop },
};
export const FetchingMoreVideos: Story = {
  args: { hasMoreVideos: true, isFetchingMoreVideos: true, onLoadMoreVideos: noop },
};
export const NoVideos: Story = { args: { videos: [], videosState: 'empty', videoCount: 0 } };
export const VideosLoading: Story = { args: { videosState: 'loading' } };
export const VideosError: Story = { args: { videosState: 'error', onRetryVideos: noop } };
export const NoPlaylists: Story = {
  args: { activeTab: 'playlists', playlists: [], playlistsState: 'empty' },
};
export const PlaylistsError: Story = {
  args: { activeTab: 'playlists', playlistsState: 'error', onRetryPlaylists: noop },
};
export const Loading: Story = { args: { state: 'loading' } };
export const Empty: Story = { args: { state: 'empty' } };
export const ErrorState: Story = { args: { state: 'error', onRetry: noop } };
export const Dark: Story = { args: { theme: 'dark' } };
