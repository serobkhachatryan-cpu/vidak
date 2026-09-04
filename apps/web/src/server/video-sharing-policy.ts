/**
 * Vidak's narrow, user-facing projection of a W3DS record `_acl` policy.
 *
 * Sharing grants READ only.  Write permissions, denials, and conditional
 * reputation policies deliberately have no UI here: the current eVault
 * implementation fails conditions closed and Vidak does not need them for
 * watching a video.
 */

export const W3DS_ACL_READ = 0x01;

export type VideoSharingAudience = 'private' | 'people' | 'groups' | 'public';

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
const audiences = ['private', 'people', 'groups', 'public'] as const;
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

/** Builds the exact W3DS `_acl` block to apply to a record once eVault writes are available. */
export function toW3dsRecordAccessControl(
  policy: Pick<VideoSharingPolicy, 'audience' | 'readerENames' | 'groupENames'>,
): W3dsRecordAccessControl {
  const grants =
    policy.audience === 'people'
      ? policy.readerENames.map((ename) => ({ ename, perms: W3DS_ACL_READ }))
      : policy.audience === 'groups'
        ? policy.groupENames.map((ename) => ({ ename, perms: W3DS_ACL_READ }))
        : [];

  return {
    v: 1,
    grants,
    denials: { enames: [], conditions: [] },
    default_perms: policy.audience === 'public' ? W3DS_ACL_READ : 0,
    require: policy.audience === 'public' ? [[]] : [],
  };
}

/** The local product policy only makes a video public for the public audience. */
export function visibilityForVideoSharingPolicy(
  policy: Pick<VideoSharingPolicy, 'audience'>,
): 'public' | 'private' {
  return policy.audience === 'public' ? 'public' : 'private';
}

export function defaultVideoSharingPolicy(input: {
  visibility: 'public' | 'unlisted' | 'private';
}): VideoSharingPolicy {
  return {
    audience: input.visibility === 'public' ? 'public' : 'private',
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
