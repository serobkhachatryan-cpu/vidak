import type { Channel, Comment, Video } from '@w3ds/types';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WatchPage } from './watch-page';

const channel: Channel = {
  id: 'channel-studio',
  ownerId: 'user-ada',
  handle: 'w3ds-studio',
  name: 'W3DS Studio',
  subscriberCount: 152_400,
  videoCount: 4,
  createdAt: '2025-01-12T09:00:00.000Z',
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

const comment: Comment = {
  id: 'comment-1',
  videoId: video.id,
  authorId: 'user-ada',
  body: 'The component examples make the system easier to understand.',
  createdAt: '2026-07-14T13:00:00.000Z',
  likeCount: 42,
  replyCount: 0,
};

describe('WatchPage', () => {
  it('renders the accessible watch experience and related videos', () => {
    const markup = renderToStaticMarkup(
      <WatchPage
        video={video}
        channel={channel}
        comments={[comment]}
        commentAuthors={{
          [comment.authorId]: {
            displayName: 'Ada Lovelace',
            handle: 'ada-lovelace',
            isVerified: true,
          },
        }}
        relatedVideos={[{ ...video, id: 'related-video', title: 'A related video' }]}
        relatedChannels={{ [channel.id]: channel }}
      />,
    );

    expect(markup).toContain('aria-label="Video player for Building a practical design system"');
    expect(markup).toContain('<h1');
    expect(markup).toContain('Building a practical design system');
    expect(markup).toContain('W3DS Studio');
    expect(markup).toContain('Subscribe');
    expect(markup).toContain('<legend class="sr-only">Video actions</legend>');
    expect(markup).toContain('aria-label="Video tags"');
    expect(markup).toContain('Up next');
    expect(markup).toContain('A related video');
    expect(markup).toContain('Comments (3)');
    expect(markup).toContain('The component examples make the system easier to understand.');
    expect(markup).toContain('xl:grid-cols-[minmax(0,1fr)_22rem]');
    expect(markup).toContain('sm:grid-cols-2 xl:grid-cols-1');
  });

  it('renders loading, empty, and error states with accessible labels', () => {
    expect(renderToStaticMarkup(<WatchPage state="loading" />)).toContain(
      'aria-label="Loading video"',
    );
    expect(renderToStaticMarkup(<WatchPage state="empty" />)).toContain('Video unavailable');
    expect(renderToStaticMarkup(<WatchPage state="error" onRetry={() => undefined} />)).toContain(
      'Could not load this video',
    );
  });

  it('supports dark mode and subscribed actions', () => {
    const markup = renderToStaticMarkup(
      <WatchPage video={video} channel={channel} theme="dark" subscribed />,
    );

    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Subscribed');
  });
});
