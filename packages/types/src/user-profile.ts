export type UserProfileId = string;

export interface UserProfile {
  id: UserProfileId;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bio?: string;
  location?: string;
  websiteUrl?: string;
  joinedAt: string;
  /** Profiles following this profile. */
  subscriberCount: number;
  /** Profiles this profile follows. Absent when the platform does not expose it. */
  followingCount?: number;
  isVerified: boolean;
}
