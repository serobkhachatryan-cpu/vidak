import type { Video } from '@w3ds/types';
import { describe, expect, it } from 'vitest';
import {
  evaultItemsForTab,
  isVideoSpaceEmpty,
  ownedItemsForTab,
  previewFallbackCopy,
  shareChangeConfirmation,
  videoSpaceEmptyCopy,
  videoSpaceTabs,
  type VideoSpaceLibraryItem,
} from './video-space-model';

const ownVideo: VideoSpaceLibraryItem = {
  id: 'own-1',
  title: 'Studio take',
  accessScope: 'personal',
  visibility: 'private',
};

const sharedVideo: VideoSpaceLibraryItem = {
  id: 'shared-1',
  title: 'Shared cut',
  accessScope: 'shared',
  visibility: 'shared-with-me',
};

const ownedPublic: Video = {
  id: 'vidak-1',
  channelId: 'channel-1',
  title: 'Published talk',
  description: '',
  thumbnailUrl: '',
  durationSeconds: 12,
  status: 'published',
  visibility: 'public',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: [],
};

describe('video space home model', () => {
  it('keeps the public explore tab separate from the private library', () => {
    expect(videoSpaceTabs.map((tab) => tab.id)).toEqual(['yours', 'shared', 'explore']);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'yours')).toEqual([ownVideo]);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'shared')).toEqual([sharedVideo]);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'explore')).toEqual([]);
    expect(ownedItemsForTab([ownedPublic], 'explore')).toEqual([]);
    expect(ownedItemsForTab([ownedPublic], 'yours')).toEqual([ownedPublic]);
  });

  it('does not treat a public feed as a substitute for an empty private library', () => {
    expect(isVideoSpaceEmpty([], [])).toBe(true);
    expect(isVideoSpaceEmpty([ownVideo], [])).toBe(false);
    expect(videoSpaceEmptyCopy.description).toMatch(/viewer and sharing layer/i);
    expect(videoSpaceEmptyCopy.description).not.toMatch(/messenger/i);
    expect(videoSpaceEmptyCopy.description).not.toMatch(/import from/i);
    expect(videoSpaceTabs.map((tab) => tab.label)).toEqual([
      'Your videos',
      'Shared with you',
      'Explore public videos',
    ]);
  });

  it('keeps processing copy off error language and failure copy secondary', () => {
    expect(previewFallbackCopy('processing').label).toBe('Preparing preview');
    expect(previewFallbackCopy('processing').description).toBe('');
    expect(previewFallbackCopy('unavailable').label).toBe('Preview unavailable');
    expect(previewFallbackCopy('unsupported').description).toBe('');
  });

  it('confirms that a share action changes only that video', () => {
    expect(shareChangeConfirmation('private')).toMatch(/only this video/i);
    expect(shareChangeConfirmation('public')).toMatch(/Public/);
  });
});
