import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Video } from '@w3ds/types';
import { Badge, Card, Heading, Stack, Text } from './index';

const sampleVideo: Video = {
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

const meta = {
  title: 'Domain/Video data',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const VideoSummary: Story = {
  render: () => (
    <Card className="w-96 overflow-hidden p-0">
      <img alt="" className="aspect-video w-full object-cover" src={sampleVideo.thumbnailUrl} />
      <Stack className="p-4" gap={2}>
        <div className="flex items-center justify-between gap-3">
          <Badge>{sampleVideo.status}</Badge>
          <Text size="sm" tone="muted">
            {Math.floor(sampleVideo.durationSeconds / 60)} min
          </Text>
        </div>
        <Heading as="h3">{sampleVideo.title}</Heading>
        <Text tone="muted">{sampleVideo.description}</Text>
        <Text size="sm" tone="muted">
          {sampleVideo.viewCount.toLocaleString()} views · {sampleVideo.commentCount} comments
        </Text>
      </Stack>
    </Card>
  ),
};
