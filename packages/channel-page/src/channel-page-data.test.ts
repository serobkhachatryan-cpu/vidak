import type { Video } from '@w3ds/types';
import { describe, expect, it } from 'vitest';
import {
  partitionUploads,
  resolveSectionState,
  SHORT_MAX_DURATION_SECONDS,
} from './channel-page-data';

const upload = (id: string, durationSeconds: number): Video => ({
  id,
  channelId: 'channel-studio',
  title: id,
  description: '',
  thumbnailUrl: 'https://example.com/thumbnail.jpg',
  durationSeconds,
  status: 'published',
  visibility: 'public',
  publishedAt: '2026-07-14T10:00:00.000Z',
  createdAt: '2026-07-10T09:30:00.000Z',
  updatedAt: '2026-07-14T10:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: [],
});

describe('partitionUploads', () => {
  it('routes uploads at or below the shorts limit to the shorts tab', () => {
    const { videos, shorts } = partitionUploads([
      upload('long', SHORT_MAX_DURATION_SECONDS + 1),
      upload('boundary', SHORT_MAX_DURATION_SECONDS),
      upload('short', 1),
    ]);

    expect(videos.map((video) => video.id)).toEqual(['long']);
    expect(shorts.map((video) => video.id)).toEqual(['boundary', 'short']);
  });

  it('returns empty tabs for an empty upload list', () => {
    expect(partitionUploads([])).toEqual({ videos: [], shorts: [] });
  });
});

describe('resolveSectionState', () => {
  it('prefers the pending state over an earlier error', () => {
    expect(
      resolveSectionState({ isPending: true, error: new Error('failed'), hasItems: false }),
    ).toBe('loading');
  });

  it('reports errors once loading has settled', () => {
    expect(
      resolveSectionState({ isPending: false, error: new Error('failed'), hasItems: true }),
    ).toBe('error');
  });

  it('distinguishes ready from empty results', () => {
    expect(resolveSectionState({ isPending: false, error: null, hasItems: true })).toBe('ready');
    expect(resolveSectionState({ isPending: false, error: null, hasItems: false })).toBe('empty');
  });
});
