import type { Channel, Playlist, Video } from '@w3ds/types';
import { describe, expect, it } from 'vitest';
import {
  formatFollowers,
  formatFollowing,
  formatJoinDate,
  formatVideoCount,
  formatWebsiteLabel,
} from './format';
import {
  ownedChannelsForUser,
  playlistsForOwnedChannels,
  resolveSectionState,
  videosForOwnedChannels,
} from './user-profile-page-data';

const channel = (id: string, ownerId: string): Channel => ({
  id,
  ownerId,
  handle: id,
  name: id,
  subscriberCount: 0,
  videoCount: 0,
  createdAt: '2025-01-12T09:00:00.000Z',
});

const video = (id: string, channelId: string): Video => ({
  id,
  channelId,
  title: id,
  description: '',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  durationSeconds: 60,
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

const playlist = (id: string, channelId: string): Playlist => ({
  id,
  channelId,
  title: id,
  visibility: 'public',
  items: [],
  createdAt: '2026-07-20T10:00:00.000Z',
  updatedAt: '2026-07-20T10:00:00.000Z',
});

describe('ownedChannelsForUser', () => {
  it('keeps only channels owned by the requested profile', () => {
    expect(
      ownedChannelsForUser(
        [channel('channel-a', 'user-ada'), channel('channel-b', 'user-grace')],
        'user-ada',
      ).map((item) => item.id),
    ).toEqual(['channel-a']);
  });

  it('returns an empty list when the profile owns nothing', () => {
    expect(ownedChannelsForUser([channel('channel-a', 'user-ada')], 'user-grace')).toEqual([]);
  });
});

describe('videosForOwnedChannels', () => {
  it('returns the API-scoped list when a primary channel is known', () => {
    const items = [video('video-a', 'channel-a'), video('video-b', 'channel-b')];
    expect(videosForOwnedChannels(items, new Set(['channel-a']), 'channel-a')).toEqual(items);
  });

  it('filters to owned channels when ownership spans multiple channels', () => {
    const items = [video('video-a', 'channel-a'), video('video-b', 'channel-b')];
    expect(
      videosForOwnedChannels(items, new Set(['channel-a']), undefined).map((item) => item.id),
    ).toEqual(['video-a']);
  });
});

describe('playlistsForOwnedChannels', () => {
  it('keeps playlists that belong to owned channels', () => {
    expect(
      playlistsForOwnedChannels(
        [playlist('playlist-a', 'channel-a'), playlist('playlist-b', 'channel-b')],
        new Set(['channel-a']),
      ).map((item) => item.id),
    ).toEqual(['playlist-a']);
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

describe('format helpers', () => {
  it('formats join dates at month precision', () => {
    expect(formatJoinDate('2025-01-12T09:00:00.000Z')).toBe('January 2025');
    expect(formatJoinDate('not-a-date')).toBeUndefined();
  });

  it('strips the scheme and trailing slash from website labels', () => {
    expect(formatWebsiteLabel('https://example.com/ada/')).toBe('example.com/ada');
    expect(formatWebsiteLabel('http://example.com')).toBe('example.com');
  });

  it('uses singular labels for single follower and video counts', () => {
    expect(formatFollowers(1)).toBe('1 follower');
    expect(formatFollowers(0)).toBe('0 followers');
    expect(formatVideoCount(1)).toBe('1 video');
    expect(formatVideoCount(2)).toBe('2 videos');
    expect(formatFollowing(1)).toBe('1 following');
  });
});
