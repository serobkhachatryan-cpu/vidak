/**
 * Visibility is a viewer-facing state, not a source-app category.
 *
 * eVault responses strip ACL (documented security behavior). When ACL is
 * absent, personal vault records stay Private and authorized foreign records
 * stay Shared with me. Nothing becomes Public unless a Vidak publish record
 * or an explicit public ACL (`*`) says so.
 */
export type VideoSpaceVisibility = 'private' | 'shared-with-me' | 'shared-by-me' | 'public';
export type VideoSpaceAccessScope = 'personal' | 'shared';

export const videoSpaceVisibilityLabels: Record<VideoSpaceVisibility, string> = {
  private: 'Private',
  'shared-with-me': 'Shared with me',
  'shared-by-me': 'Shared by me',
  public: 'Public',
};

export function visibilityForEVaultVideo(input: {
  accessScope: VideoSpaceAccessScope;
  acl?: readonly string[] | undefined;
  viewerEName?: string | undefined;
}): VideoSpaceVisibility {
  if (input.accessScope === 'shared') return 'shared-with-me';

  const acl = (input.acl ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (acl.includes('*')) return 'public';

  const viewer = input.viewerEName?.trim();
  const others = acl.filter((entry) => entry !== '*' && entry !== viewer);
  if (others.length > 0) return 'shared-by-me';
  return 'private';
}

export function visibilityForOwnedVidakVideo(input: {
  status: string;
  visibility: string;
}): VideoSpaceVisibility {
  if (input.status !== 'published') return 'private';
  if (input.visibility === 'public') return 'public';
  if (input.visibility === 'unlisted') return 'shared-by-me';
  return 'private';
}
