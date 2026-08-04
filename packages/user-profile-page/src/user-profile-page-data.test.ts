import type { Channel } from '@w3ds/types';
import { describe, expect, it } from 'vitest';
import { formatJoinDate, formatWebsiteLabel } from './format';
import { ownedChannelsForUser, resolveSectionState } from './user-profile-page-data';

const channel = (id: string, ownerId: string): Channel => ({
  id,
  ownerId,
  handle: id,
  name: id,
  subscriberCount: 0,
  videoCount: 0,
  createdAt: '2025-01-12T09:00:00.000Z',
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
});
