/**
 * Vidak's narrow, user-facing projection of a W3DS record `_acl` policy.
 *
 * Sharing grants READ only.  Write permissions, denials, and conditional
 * reputation policies deliberately have no UI here: the current eVault
 * implementation fails conditions closed and Vidak does not need them for
 * watching a video.
 */

export const W3DS_ACL_READ = 0x01;
/** The record owner must retain every documented permission. */
export const W3DS_ACL_FULL = 0x0f;

export type VideoSharingAudience = 'private' | 'people' | 'groups' | 'public' | 'unlisted';

export interface W3dsRecordAclGrant {
  ename: string;
  perms: number;
}

export interface W3dsRecordAccessControl {
  v: 1;
  grants: W3dsRecordAclGrant[];
  denials: { enames: string[]; conditions: [] };
  default_perms: number;
  /** An empty group is the documented always-passing requirement. */
  require: Array<[]>;
}

export interface VideoSharingPolicy {
  audience: VideoSharingAudience;
  readerENames: string[];
  groupENames: string[];
  /** Opaque path segment. It does not authorize a recipient by itself. */
  shareToken?: string;
  updatedAt?: string;
}

export interface UpdateVideoSharingPolicyInput {
  audience: VideoSharingAudience;
  readerENames?: unknown;
  groupENames?: unknown;
}

const eNamePattern = /^@[^\s@]{1,254}$/;
const audiences = ['private', 'people', 'groups', 'public', 'unlisted'] as const;
const MAX_POLICY_PARTIES = 50;

export class VideoSharingPolicyError extends Error {
  readonly code = 'validation_failed';
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'VideoSharingPolicyError';
  }
}

/** Strictly validates the small policy surface accepted from a browser. */
export function normalizeVideoSharingPolicyInput(
  input: unknown,
): Omit<VideoSharingPolicy, 'shareToken' | 'updatedAt'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VideoSharingPolicyError('Sharing settings are invalid.');
  }
  const candidate = input as UpdateVideoSharingPolicyInput;
  if (!(audiences as readonly string[]).includes(candidate.audience)) {
    throw new VideoSharingPolicyError('Choose who can watch this video.');
  }
  const readerENames = normalizeENames(candidate.readerENames, 'People');
  const groupENames = normalizeENames(candidate.groupENames, 'Groups');
  if (candidate.audience === 'people' && readerENames.length === 0) {
    throw new VideoSharingPolicyError('Add at least one person to share with.');
  }
  if (candidate.audience === 'groups' && groupENames.length === 0) {
    throw new VideoSharingPolicyError('Add at least one group to share with.');
  }
  return {
    audience: candidate.audience,
    readerENames: candidate.audience === 'people' ? readerENames : [],
    groupENames: candidate.audience === 'groups' ? groupENames : [],
  };
}

/**
 * Builds the exact W3DS `_acl` block for one owner-controlled record.
 *
 * The owner gets `0x0f` explicitly. eVault does not infer this from record
 * ownership once `_acl` is present, so omitting it could leave an owner with
 * read-only access (public) or no access (private).
 */
export function toW3dsRecordAccessControl(
  policy: Pick<VideoSharingPolicy, 'audience' | 'readerENames' | 'groupENames'>,
  ownerEName: string,
): W3dsRecordAccessControl {
  const owner = normalizePolicyEName(ownerEName, 'Owner');
  const audienceGrants =
    policy.audience === 'people'
      ? policy.readerENames.map((ename) => ({ ename, perms: W3DS_ACL_READ }))
      : policy.audience === 'groups'
        ? policy.groupENames.map((ename) => ({ ename, perms: W3DS_ACL_READ }))
        : [];
  // A direct grant is the most-specific eVault ACL match. Keep the owner
  // first and remove accidental duplicate recipient entries so the owner can
  // never be narrowed from full control to READ.
  const grants = [
    { ename: owner, perms: W3DS_ACL_FULL },
    ...audienceGrants.filter((grant) => grant.ename !== owner),
  ];

  return {
    v: 1,
    grants,
    denials: { enames: [], conditions: [] },
    // eVault ACL has no discovery dimension. Both public and link-only
    // records are readable by anyone who can resolve their record; Vidak
    // keeps link-only videos out of its catalogue at the routing layer.
    default_perms:
      policy.audience === 'public' || policy.audience === 'unlisted' ? W3DS_ACL_READ : 0,
    require: policy.audience === 'public' || policy.audience === 'unlisted' ? [[]] : [],
  };
}

/** Maps a user-facing sharing choice to Vidak's distinct routing visibility. */
export function visibilityForVideoSharingPolicy(
  policy: Pick<VideoSharingPolicy, 'audience'>,
): 'public' | 'unlisted' | 'private' {
  if (policy.audience === 'public') return 'public';
  if (policy.audience === 'unlisted') return 'unlisted';
  return 'private';
}

export function defaultVideoSharingPolicy(input: {
  visibility: 'public' | 'unlisted' | 'private';
}): VideoSharingPolicy {
  return {
    audience: input.visibility,
    readerENames: [],
    groupENames: [],
  };
}

function normalizeENames(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new VideoSharingPolicyError(`${label} must be a list of eID names.`);
  }
  if (value.length > MAX_POLICY_PARTIES) {
    throw new VideoSharingPolicyError(
      `You can add up to ${MAX_POLICY_PARTIES} ${label.toLocaleLowerCase()}.`,
    );
  }
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new VideoSharingPolicyError(`${label} must be eID names starting with @.`);
    }
    const ename = item.trim();
    if (!eNamePattern.test(ename)) {
      throw new VideoSharingPolicyError(`${label} must be valid eID names starting with @.`);
    }
    result.add(ename);
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

function normalizePolicyEName(value: string, label: string): string {
  const eName = value.trim();
  if (!eNamePattern.test(eName)) {
    throw new VideoSharingPolicyError(`${label} must be a valid eID name starting with @.`);
  }
  return eName;
}
