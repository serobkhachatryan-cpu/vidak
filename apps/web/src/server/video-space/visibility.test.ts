import { describe, expect, it } from 'vitest';
import {
  videoSpaceVisibilityLabels,
  visibilityForEVaultVideo,
  visibilityForOwnedVidakVideo,
} from './visibility';

describe('video space visibility', () => {
  it('keeps an owned eVault video private unless ACL names other people or the public wildcard', () => {
    expect(visibilityForEVaultVideo({ accessScope: 'personal', viewerEName: '@owner.w3id' })).toBe(
      'private',
    );
    expect(
      visibilityForEVaultVideo({
        accessScope: 'personal',
        viewerEName: '@owner.w3id',
        acl: ['@owner.w3id'],
      }),
    ).toBe('private');
    expect(
      visibilityForEVaultVideo({
        accessScope: 'personal',
        viewerEName: '@owner.w3id',
        acl: ['@owner.w3id', '@friend.w3id'],
      }),
    ).toBe('shared-by-me');
    expect(
      visibilityForEVaultVideo({
        accessScope: 'personal',
        viewerEName: '@owner.w3id',
        acl: ['*'],
      }),
    ).toBe('public');
  });

  it('labels an authorized foreign record as shared with me', () => {
    expect(
      visibilityForEVaultVideo({
        accessScope: 'shared',
        viewerEName: '@viewer.w3id',
        acl: ['*'],
      }),
    ).toBe('shared-with-me');
  });

  it('maps Vidak publish state without making drafts public', () => {
    expect(visibilityForOwnedVidakVideo({ status: 'draft', visibility: 'public' })).toBe('private');
    expect(visibilityForOwnedVidakVideo({ status: 'published', visibility: 'private' })).toBe(
      'private',
    );
    expect(visibilityForOwnedVidakVideo({ status: 'published', visibility: 'unlisted' })).toBe(
      'shared-by-me',
    );
    expect(visibilityForOwnedVidakVideo({ status: 'published', visibility: 'public' })).toBe(
      'public',
    );
  });

  it('uses the four product visibility labels', () => {
    expect(videoSpaceVisibilityLabels.private).toBe('Private');
    expect(videoSpaceVisibilityLabels['shared-with-me']).toBe('Shared with me');
    expect(videoSpaceVisibilityLabels['shared-by-me']).toBe('Shared by me');
    expect(videoSpaceVisibilityLabels.public).toBe('Public');
  });
});
