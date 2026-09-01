import type { Video } from '@w3ds/types';
import { describe, expect, it } from 'vitest';
import {
  evaultItemsForTab,
  isVideoSpaceEmpty,
  libraryCardDetails,
  libraryDiscoveryBanner,
  libraryProgressCopy,
  libraryUpdatingCopy,
  ownedItemsForTab,
  previewFallbackCopy,
  shareChangeConfirmation,
  sharedInventoryBanner,
  type VideoSpaceLibraryItem,
  videoSpaceEmptyCopy,
  videoSpaceTabs,
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
    expect(videoSpaceTabs.map((tab) => tab.id)).toEqual(['all', 'yours', 'shared', 'explore']);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'all')).toEqual([ownVideo, sharedVideo]);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'yours')).toEqual([ownVideo]);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'shared')).toEqual([sharedVideo]);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'explore')).toEqual([]);
    expect(ownedItemsForTab([ownedPublic], 'explore')).toEqual([]);
    expect(ownedItemsForTab([ownedPublic], 'all')).toEqual([ownedPublic]);
    expect(ownedItemsForTab([ownedPublic], 'yours')).toEqual([ownedPublic]);
    expect(ownedItemsForTab([ownedPublic], 'shared')).toEqual([]);
  });

  it('does not treat a public feed as a substitute for an empty private library', () => {
    expect(isVideoSpaceEmpty([], [])).toBe(true);
    expect(isVideoSpaceEmpty([ownVideo], [])).toBe(false);
    expect(videoSpaceEmptyCopy.description).toMatch(/viewer and sharing layer/i);
    expect(videoSpaceEmptyCopy.description).not.toMatch(/messenger/i);
    expect(videoSpaceEmptyCopy.description).not.toMatch(/import from/i);
    expect(videoSpaceTabs.map((tab) => tab.label)).toEqual([
      'All videos',
      'My videos',
      'Shared with me',
      'Public videos published in Vidak',
    ]);
  });

  it('keeps processing copy off error language and failure copy secondary', () => {
    expect(previewFallbackCopy('processing').label).toBe('Preparing preview');
    expect(previewFallbackCopy('processing').description).toBe('');
    expect(previewFallbackCopy('unavailable').label).toBe('Preview unavailable');
    expect(previewFallbackCopy('unsupported').description).toBe('');
  });

  it('keeps counts-only completeness copy and treats My videos / Shared with me as filters', () => {
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'all')).toEqual([ownVideo, sharedVideo]);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'shared')).toEqual([sharedVideo]);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'yours')).toEqual([ownVideo]);
    expect(evaultItemsForTab([ownVideo, sharedVideo], 'explore')).toEqual([]);
    const banner = sharedInventoryBanner({
      indexed: 12,
      expected: 15,
      denied: 0,
      missing: 0,
      complete: false,
      retryNeeded: true,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
    });
    expect(banner).toBe('12 of 15 shared spaces indexed; retry needed.');
    expect(banner).not.toMatch(/@|[a-f0-9-]{8,}|messenger|meshenger|group|chat|title/i);
    expect(
      sharedInventoryBanner({
        indexed: 2,
        expected: 2,
        denied: 0,
        missing: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
      }),
    ).toBeUndefined();
    expect(
      sharedInventoryBanner({
        indexed: 0,
        expected: 7,
        denied: 7,
        missing: 0,
        complete: true,
        retryNeeded: false,
        retryUnavailable: 0,
        retryRejected: 0,
        retryRateLimited: 0,
      }),
    ).toBe('0 of 7 shared spaces indexed; 7 denied by current access.');
  });

  it('keeps visible counts while the library is still updating', () => {
    expect(libraryUpdatingCopy(3)).toBe('Showing 3 videos — updating your library…');
    expect(libraryUpdatingCopy(1)).toBe('Showing 1 video — updating your library…');
    expect(
      libraryProgressCopy({
        itemCount: 18,
        shared: true,
        discovery: 'refreshing',
        completeness: {
          indexed: 5,
          expected: 7,
          denied: 0,
          missing: 0,
          complete: false,
          retryNeeded: false,
          retryUnavailable: 0,
          retryRejected: 0,
          retryRateLimited: 0,
          retrying: 2,
          deferred: 0,
        },
      }),
    ).toBe('18 shared videos found · 5 of 7 spaces indexed · retrying 2');
    expect(
      libraryProgressCopy({
        itemCount: 6,
        shared: true,
        discovery: 'refreshing',
        completeness: {
          indexed: 3,
          expected: 12,
          denied: 0,
          missing: 0,
          complete: false,
          retryNeeded: false,
          retryUnavailable: 0,
          retryRejected: 0,
          retryRateLimited: 10,
          retrying: 0,
          deferred: 3,
        },
      }),
    ).toBe(
      '6 shared videos found · 3 of 12 spaces indexed · still synchronizing — will continue automatically',
    );
    expect(
      libraryProgressCopy({
        itemCount: 11,
        shared: false,
        discovery: 'refreshing',
        completeness: {
          indexed: 7,
          expected: 7,
          denied: 0,
          missing: 0,
          complete: false,
          retryNeeded: false,
          retryUnavailable: 0,
          retryRejected: 0,
          retryRateLimited: 0,
          retrying: 1,
          coverage: {
            chatPages: 3,
            messagePages: 20,
            filePages: 4,
            w3dsFilePages: 2,
            groupManifestPages: 2,
            callSessionPages: 3,
            groupHistories: 12,
            directChats: 4,
            referenceGrants: 7,
            officialChatGrants: 9,
          },
        },
      }),
    ).toBe(
      '11 videos found · 7 of 7 spaces indexed · retrying 1 · 12 histories · 4 directs · 34 pages scanned',
    );
    expect(
      libraryProgressCopy({
        itemCount: 8,
        shared: true,
        discovery: 'refreshing',
        completeness: {
          indexed: 9,
          expected: 12,
          denied: 0,
          missing: 0,
          complete: false,
          retryNeeded: false,
          retryUnavailable: 0,
          retryRejected: 0,
          retryRateLimited: 0,
          retrying: 3,
          media: {
            candidates: 20,
            accepted: 8,
            excludedNonVideo: 9,
            unresolved: { missing_w3ds_file_uri: 2, resolver_denied: 1 },
          },
        },
      }),
    ).toBe(
      '8 shared videos found · 9 of 12 spaces indexed · retrying 3 · 20 media records · 8 playable · 9 non-video · unresolved 2 missing_w3ds_file_uri, 1 resolver_denied',
    );
    expect(
      libraryDiscoveryBanner({
        discovery: 'refreshing',
        itemCount: 4,
        shared: false,
      }),
    ).toBe('4 videos found · still synchronizing — will continue automatically');
    expect(
      libraryDiscoveryBanner({
        discovery: 'complete',
        itemCount: 4,
        completeness: {
          indexed: 2,
          expected: 2,
          denied: 0,
          missing: 0,
          complete: true,
          retryNeeded: false,
          retryUnavailable: 0,
          retryRejected: 0,
          retryRateLimited: 0,
        },
      }),
    ).toBeUndefined();
  });

  it('confirms that a share action changes only that video', () => {
    expect(shareChangeConfirmation('private')).toMatch(/only this video/i);
    expect(shareChangeConfirmation('public')).toMatch(/Public/);
  });

  it('keeps card metadata useful without repeating the privacy badge', () => {
    expect(
      libraryCardDetails({
        durationSeconds: 95,
        createdAt: '2026-08-01T00:00:00.000Z',
        accessScope: 'personal',
        visibility: 'private',
        kind: 'file',
      }),
    ).toMatch(/1:35/);
    expect(
      libraryCardDetails({
        accessScope: 'shared',
        visibility: 'shared-with-me',
        kind: 'video-message',
      }),
    ).toBe('Shared with you');
    expect(
      libraryCardDetails({
        accessScope: 'personal',
        visibility: 'private',
        kind: 'call-recording',
      }),
    ).toBe('Your call recording');
  });
});
