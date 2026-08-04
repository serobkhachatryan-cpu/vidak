export type UserProfileId = string;

export interface UserProfile {
  id: UserProfileId;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  joinedAt: string;
  subscriberCount: number;
  isVerified: boolean;
}
