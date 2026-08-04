import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Channel, Video } from '@w3ds/types';
import { VideoCard, VideoCardSkeleton } from './video-card.js';

const video: Video = {
  id: 'video-design-system',
  channelId: 'channel-studio',
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
  tags: [],
};

const channel: Channel = {
  id: 'channel-studio',
  ownerId: 'user-ada',
  handle: 'w3ds-studio',
  name: 'W3DS Studio',
  subscriberCount: 152_400,
  videoCount: 4,
  createdAt: '2025-01-12T09:00:00.000Z',
};

describe('VideoCard', () => {
  it('renders accessible video and channel links with lazy media', () => {
    const markup = renderToStaticMarkup(<VideoCard video={video} channel={channel} />);

    expect(markup).toContain('href="/watch/video-design-system"');
    expect(markup).toContain('aria-label="Watch Building a practical design system"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('12:22');
    expect(markup).toContain('W3DS Studio');
    expect(markup).toContain('98.3K views');
  });

  it('renders a labelled loading skeleton', () => {
    const markup = renderToStaticMarkup(<VideoCardSkeleton />);

    expect(markup).toContain('aria-label="Loading video"');
    expect(markup).toContain('aspect-video');
  });
});
