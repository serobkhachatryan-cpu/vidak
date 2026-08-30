import type { Video } from '@w3ds/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createPublicViewRecorder,
  hasReachedMeaningfulPlayback,
  replacePublicVideoInPages,
} from './meaningful-playback';

const video: Video = {
  id: 'vidak-1',
  channelId: 'channel-1',
  channel: { id: 'channel-1', name: 'Ada', handle: 'ada' },
  title: 'Talk',
  description: '',
  thumbnailUrl: '',
  durationSeconds: 12,
  status: 'published',
  visibility: 'public',
  publicVideoId: 'pub_1',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: [],
};

describe('meaningful playback view recording', () => {
  it('requires a few seconds of playback before counting', () => {
    expect(hasReachedMeaningfulPlayback(0, 60)).toBe(false);
    expect(hasReachedMeaningfulPlayback(2.9, 60)).toBe(false);
    expect(hasReachedMeaningfulPlayback(3, 60)).toBe(true);
  });

  it('counts short videos after a quarter of their duration', () => {
    expect(hasReachedMeaningfulPlayback(1, 4)).toBe(true);
    expect(hasReachedMeaningfulPlayback(0.5, 4)).toBe(false);
  });

  it('increments once for meaningful playback and ignores later replay in the same session', async () => {
    const record = vi.fn(async () => ({
      counted: true,
      video: { ...video, viewCount: 1 },
    }));
    const recorder = createPublicViewRecorder(record);

    await expect(recorder.onPlaybackProgress('pub_1', 1, 60)).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();

    await expect(recorder.onPlaybackProgress('pub_1', 3, 60)).resolves.toMatchObject({
      counted: true,
      video: { viewCount: 1 },
    });
    await expect(recorder.onPlaybackProgress('pub_1', 10, 60)).resolves.toBeUndefined();
    await expect(recorder.onPlaybackProgress('pub_1', 0, 60)).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('updates public card and watch cache after a counted view', () => {
    const next = { ...video, viewCount: 1 };
    const cards = replacePublicVideoInPages(
      { items: [video, { ...video, id: 'other', publicVideoId: 'pub_other' }] },
      next,
    );
    expect(cards.items?.[0]?.viewCount).toBe(1);
    expect(cards.items?.[1]?.viewCount).toBe(0);

    const pages = replacePublicVideoInPages({ pages: [{ items: [video] }] }, next);
    expect(pages.pages?.[0]?.items[0]?.viewCount).toBe(1);
  });
});
