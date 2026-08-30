import {
  isChosenPublicDisplayName,
  isPlatformPlaceholderDisplayName,
  isPublicHandle,
  isValidPublicDisplayName,
  looksLikeTechnicalIdentifier,
  type PublicDisplayNameIdentity,
} from './public-display-name';
import type { UserProfileId } from './user-profile';

export type ChannelId = string;

export interface Channel {
  id: ChannelId;
  ownerId: UserProfileId;
  handle: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  subscriberCount: number;
  videoCount: number;
  createdAt: string;
}

/**
 * Safe public channel fields for anonymous video cards and watch pages.
 * Omits owner identity, eNames, and other non-public profile data.
 */
export interface PublicChannelProjection {
  id: ChannelId;
  name: string;
  handle: string;
  avatarUrl?: string;
  subscriberCount?: number;
}

/**
 * Label for videos that have no creator-channel concept (imported/external
 * sources). Never a fake channel name or profile link.
 */
export const SOURCE_NEUTRAL_CHANNEL_LABEL = 'Independent source';

/**
 * Neutral label for a real Vidak creator channel whose stored name is still a
 * technical placeholder. Never a person/profile impersonation.
 */
export const NEUTRAL_PUBLIC_CHANNEL_NAME = 'Vidak channel';

export interface PublicChannelPresentation {
  label: string;
  /** Present only when the channel is a real Vidak creator channel. */
  href?: string;
  /** Present only when the handle is a chosen public username. */
  handle?: string;
}

function identityFromChannel(
  channel?: { id?: string } | null,
  identity?: PublicDisplayNameIdentity,
): PublicDisplayNameIdentity | undefined {
  if (identity) return identity;
  const id = channel?.id?.trim();
  return id ? { id } : undefined;
}

/**
 * True when the stored channel name is a technical placeholder we may repair.
 * Genuinely chosen channel names stay untouched.
 */
export function isReplaceableChannelName(
  value: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): boolean {
  const name = value?.trim() ?? '';
  if (!name) return true;
  if (name === NEUTRAL_PUBLIC_CHANNEL_NAME) return true;
  if (isPlatformPlaceholderDisplayName(name)) return true;
  return !isValidPublicDisplayName(name, identity);
}

/**
 * Public channel title from the owner's chosen/verified name, or the neutral
 * Vidak channel label when the owner has no safe public name yet.
 */
export function publicChannelNameFromOwner(
  ownerDisplayName: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): string {
  if (isChosenPublicDisplayName(ownerDisplayName, identity)) {
    return ownerDisplayName.trim();
  }
  return NEUTRAL_PUBLIC_CHANNEL_NAME;
}

/**
 * Repair a stored channel name in place when it is still a technical
 * placeholder. Never overwrites a genuinely chosen channel name.
 */
export function repairedChannelName(input: {
  storedName: string | null | undefined;
  ownerDisplayName?: string | null;
  identity?: PublicDisplayNameIdentity;
}): { name: string; shouldPersist: boolean } {
  const stored = input.storedName?.trim() ?? '';
  if (!isReplaceableChannelName(stored, input.identity)) {
    return { name: stored, shouldPersist: false };
  }
  const next = publicChannelNameFromOwner(input.ownerDisplayName, input.identity);
  return { name: next, shouldPersist: next !== stored };
}

export function publicHandleOrEmpty(
  handle: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): string {
  if (!isPublicHandle(handle, identity)) return '';
  return handle.trim().replace(/^@/, '');
}

/**
 * Safe public card/watch projection. Never emits UUID/eName/local-ID labels.
 */
export function toSafePublicChannelProjection(input: {
  id: string;
  name: string;
  handle: string;
  avatarUrl?: string | null;
  subscriberCount?: number;
  ownerDisplayName?: string | null;
  identity?: PublicDisplayNameIdentity;
}): PublicChannelProjection {
  const identity = input.identity ?? { id: input.id };
  const { name } = repairedChannelName({
    storedName: input.name,
    ...(input.ownerDisplayName !== undefined ? { ownerDisplayName: input.ownerDisplayName } : {}),
    identity,
  });
  const handle = publicHandleOrEmpty(input.handle, identity);
  return {
    id: input.id,
    name,
    handle,
    ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
    ...(typeof input.subscriberCount === 'number'
      ? { subscriberCount: input.subscriberCount }
      : {}),
  };
}

/**
 * Card/watch/channel presentation. Technical identifiers never appear in the
 * visible label, aria-label, or handle text. Source videos without a real
 * channel identity get a source-neutral label and no profile link.
 */
export function presentPublicChannel(
  channel?: {
    id?: string;
    name?: string;
    handle?: string;
  } | null,
  options?: { href?: string; identity?: PublicDisplayNameIdentity },
): PublicChannelPresentation {
  const id = channel?.id?.trim();
  if (!id) {
    return { label: SOURCE_NEUTRAL_CHANNEL_LABEL };
  }

  const identity = identityFromChannel(channel, options?.identity);
  const storedName = channel?.name?.trim() ?? '';
  const label =
    isChosenPublicDisplayName(storedName, identity) || storedName === NEUTRAL_PUBLIC_CHANNEL_NAME
      ? storedName
      : looksLikeTechnicalIdentifier(storedName) ||
          isPlatformPlaceholderDisplayName(storedName) ||
          !isValidPublicDisplayName(storedName, identity)
        ? NEUTRAL_PUBLIC_CHANNEL_NAME
        : storedName;

  const handle = publicHandleOrEmpty(channel?.handle, identity);

  return {
    label,
    href: options?.href ?? `/channel/${id}`,
    ...(handle ? { handle } : {}),
  };
}
