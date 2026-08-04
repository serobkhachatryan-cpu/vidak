import type { UserProfileId } from './user-profile.js';

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
