import type { Channel, Video } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VideoCard, VideoCardSkeleton } from './video-card';

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
    expect(markup).toContain('src="https://example.com/thumbnail.jpg"');
  });

  it('prefers the opaque public video id for watch links when present', () => {
    const markup = renderToStaticMarkup(
      <VideoCard video={{ ...video, publicVideoId: 'pub_design-system' }} channel={channel} />,
    );
    expect(markup).toContain('href="/watch/pub_design-system"');
    expect(markup).not.toContain('href="/watch/video-design-system"');
  });

  it('renders a labelled loading skeleton', () => {
    const markup = renderToStaticMarkup(<VideoCardSkeleton />);

    expect(markup).toContain('aria-label="Loading video"');
    expect(markup).toContain('aspect-video');
  });

  it('renders a safe placeholder instead of a broken img for empty thumbnails', () => {
    const markup = renderToStaticMarkup(
      <VideoCard video={{ ...video, thumbnailUrl: '' }} channel={channel} />,
    );
    expect(markup).toContain('thumbnail unavailable');
    expect(markup).not.toContain('<img');
  });

  it('renders a safe placeholder instead of a broken img for blob thumbnails', () => {
    const markup = renderToStaticMarkup(
      <VideoCard
        video={{
          ...video,
          title: 'IMG 1589',
          thumbnailUrl: 'blob:https://vidak.postplatforms.com/5a7f2e33-93c3-438d-9781-f897d3e1a58d',
        }}
        channel={channel}
      />,
    );
    expect(markup).toContain('IMG 1589 thumbnail unavailable');
    expect(markup).not.toContain('blob:');
    expect(markup).not.toContain('<img');
  });
});
