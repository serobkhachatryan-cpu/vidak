import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Channel, Video } from '@w3ds/types';
import { Grid, VideoCard, VideoCardSkeleton } from './index.js';

const video: Video = {
  id: 'video-design-system',
  channelId: 'channel-studio',
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
  tags: ['design systems', 'frontend', 'product design'],
};

const channel: Channel = {
  id: 'channel-studio',
  ownerId: 'user-ada',
  handle: 'w3ds-studio',
  name: 'W3DS Studio',
  avatarUrl: 'https://images.unsplash.com/photo-1618005198919-d3d4b5a92ead?w=160&h=160&fit=crop',
  subscriberCount: 152_400,
  videoCount: 4,
  createdAt: '2025-01-12T09:00:00.000Z',
};

const meta = {
  title: 'Domain/Video card',
  component: VideoCard,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof VideoCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { video, channel },
};

export const Loading: Story = {
  render: () => <VideoCardSkeleton className="w-80" />,
};

export const ResponsiveGrid: Story = {
  render: () => (
    <Grid columns={5} gap={6}>
      {Array.from({ length: 5 }, (_, index) => (
        <VideoCard key={index} video={{ ...video, id: `${video.id}-${index}` }} channel={channel} />
      ))}
    </Grid>
  ),
};
