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
