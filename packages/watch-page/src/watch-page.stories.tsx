import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Channel, Video } from '@w3ds/types';
import { WatchPage } from './watch-page';

const channel: Channel = {
  id: 'channel-studio',
  ownerId: 'user-ada',
  handle: 'vidak-studio',
  name: 'Vidak Studio',
  avatarUrl: 'https://images.unsplash.com/photo-1618005198919-d3d4b5a92ead?w=160&h=160&fit=crop',
  subscriberCount: 152_400,
  videoCount: 4,
  createdAt: '2025-01-12T09:00:00.000Z',
};

const video: Video = {
  id: 'video-design-system',
  channelId: channel.id,
  title: 'Building a practical design system',
  description:
    'A tour of the decisions that keep a design system useful as a product grows.\n\nWe cover tokens, components, and the feedback loops that make a system last.',
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
  tags: ['design systems', 'frontend', 'product design'],
};

const relatedVideos = Array.from({ length: 4 }, (_, index) => ({
  ...video,
  id: `related-${index}`,
  title: `Related design system lesson ${index + 1}`,
  viewCount: 10_000 * (index + 1),
}));

const meta = {
  title: 'Pages/Watch page',
  component: WatchPage,
  parameters: { layout: 'fullscreen' },
  args: {
    video,
    channel,
    relatedVideos,
    relatedChannels: { [channel.id]: channel },
  },
} satisfies Meta<typeof WatchPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Subscribed: Story = {
  args: { subscribed: true },
};

export const Loading: Story = {
  args: { state: 'loading' },
};

export const Empty: Story = {
  args: { state: 'empty' },
};

export const UnavailableVideo: Story = {
  args: { state: 'empty' },
};

export const ErrorState: Story = {
  args: { state: 'error' },
};

export const PublishedPublicPlayer: Story = {
  args: {
    video: { ...video, publicVideoId: 'pub_design-system', visibility: 'public' },
    mediaSrc: '/api/videos/public/pub_design-system/media/asset-design/content',
  },
};

export const PublishedUnlistedPlayer: Story = {
  args: {
    video: { ...video, publicVideoId: 'pub_unlisted', visibility: 'unlisted' },
    mediaSrc: '/api/videos/public/pub_unlisted/media/asset-design/content',
  },
};

export const Dark: Story = {
  args: { theme: 'dark' },
};
