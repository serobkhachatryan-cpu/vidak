import { describe, expect, it } from 'vitest';
import { durableDraftThumbnailUrl, sanitizePublicThumbnailUrl } from './public-video-playback';

describe('public video thumbnail URL resolution', () => {
  const baseVideo = {
    id: 'video-1',
    channelId: 'channel-1',
    title: 'IMG 1589',
    description: '',
    durationSeconds: 12,
    status: 'published' as const,
    visibility: 'public' as const,
    publishedAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    viewCount: 1,
    likeCount: 0,
    commentCount: 0,
    tags: [] as string[],
    publicVideoId: 'pub_a6816e18-d084-488b-be44-f75bc4575f86',
  };

  it('clears persisted blob and data thumbnail URLs from public projections', () => {
    expect(
      sanitizePublicThumbnailUrl({
        ...baseVideo,
        thumbnailUrl: 'blob:https://vidak.postplatforms.com/5a7f2e33-93c3-438d-9781-f897d3e1a58d',
      }).thumbnailUrl,
    ).toBe('');

    expect(
      sanitizePublicThumbnailUrl({
        ...baseVideo,
        thumbnailUrl: 'data:image/png;base64,abc',
      }).thumbnailUrl,
    ).toBe('');

    expect(
      sanitizePublicThumbnailUrl({
        ...baseVideo,
        thumbnailUrl: 'https://cdn.example/thumb.jpg',
      }).thumbnailUrl,
    ).toBe('https://cdn.example/thumb.jpg');
  });

  it('builds a durable draft thumbnail path without inventing storage ids', () => {
    expect(durableDraftThumbnailUrl('draft-1')).toBe('/api/videos/drafts/draft-1/thumbnail');
    expect(durableDraftThumbnailUrl('draft/1')).toBe('/api/videos/drafts/draft%2F1/thumbnail');
    expect(durableDraftThumbnailUrl('draft-1')).not.toMatch(/storageKey|media_/);
  });
});
