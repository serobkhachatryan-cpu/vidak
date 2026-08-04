import type { UserProfileId } from './user-profile';
import type { VideoId } from './video';

export type CommentId = string;

export interface Comment {
  id: CommentId;
  videoId: VideoId;
  authorId: UserProfileId;
  parentId?: CommentId;
  body: string;
  createdAt: string;
  updatedAt?: string;
  likeCount: number;
  replyCount: number;
}
