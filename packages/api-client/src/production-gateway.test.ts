import { describe, expect, it } from 'vitest';
import {
  emptyCursorPage,
  filterPublicVideos,
  ProductionFeatureUnavailableError,
  sessionLocalPreferences,
  userProfileFromAuthUser,
} from './production-gateway';

describe('production gateway helpers', () => {
  it('never maps another account or a technical identifier as a public profile', () => {
    expect(
      userProfileFromAuthUser(
        {
          id: 'w3ds_signed-in',
          displayName: 'Ada Lovelace',
          profile: { displayName: 'Ada Lovelace', handle: 'ada-lovelace' },
        },
        'w3ds_other',
      ),
    ).toBeUndefined();
    expect(
      userProfileFromAuthUser({
        id: 'w3ds_signed-in',
        displayName: 'fd10387a-b0d3-5f9c-bf54-7214a491cace',
        eName: '@ada.w3id',
        profile: { handle: 'w3ds_signed-in' },
      })?.displayName,
    ).toBe('');
  });

  it('keeps a chosen public name and a chosen handle', () => {
    expect(
      userProfileFromAuthUser({
        id: 'user-1',
        displayName: 'Ada Lovelace',
        profile: { displayName: 'Ada Lovelace', handle: 'ada-lovelace', bio: 'Notes' },
      }),
    ).toMatchObject({
      id: 'user-1',
      displayName: 'Ada Lovelace',
      handle: 'ada-lovelace',
      bio: 'Notes',
    });
  });

  it('filters public discovery in-place without inventing rows', () => {
    const page = {
      items: [
        {
          id: 'a',
          channelId: 'c1',
          title: 'Ada lecture',
          description: '',
          thumbnailUrl: '',
          durationSeconds: 1,
          status: 'published' as const,
          visibility: 'public' as const,
          createdAt: '2026-08-02T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
          viewCount: 1,
          likeCount: 0,
          commentCount: 0,
          tags: [],
        },
        {
          id: 'b',
          channelId: 'c2',
          title: 'Other',
          description: '',
          thumbnailUrl: '',
          durationSeconds: 1,
          status: 'published' as const,
          visibility: 'public' as const,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
          viewCount: 9,
          likeCount: 0,
          commentCount: 0,
          tags: [],
        },
      ],
      nextCursor: 'offset:2',
    };
    expect(
      filterPublicVideos(page, { search: 'Ada' }, { limit: 10 }).items.map((item) => item.id),
    ).toEqual(['a']);
    expect(emptyCursorPage().items).toEqual([]);
  });

  it('merges preference patches without inventing mock catalogue rows', () => {
    const next = sessionLocalPreferences(undefined, { appearance: 'dark' });
    expect(next.appearance).toBe('dark');
    expect(next.language).toBe('en');
    expect(
      new ProductionFeatureUnavailableError('comments', 'Comments are not available yet.'),
    ).toMatchObject({ code: 'feature_unavailable', feature: 'comments' });
  });
});
