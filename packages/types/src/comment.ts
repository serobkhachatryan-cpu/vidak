import type { UserProfileId } from './user-profile';
import type { VideoId } from './video';

export type CommentId = string;

export type CommentSort = 'top' | 'newest';
export type CommentReaction = 'like' | 'dislike';

export interface CommentRichText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

export interface Comment {
  id: CommentId;
  videoId: VideoId;
  authorId: UserProfileId;
  parentId?: CommentId;
  body: string;
  richText?: readonly CommentRichText[];
  createdAt: string;
  updatedAt?: string;
  likeCount: number;
  dislikeCount?: number;
  viewerReaction?: CommentReaction;
  replyCount: number;
}

export interface CommentListFilters {
  parentId?: CommentId;
  sort?: CommentSort;
}

export interface CreateCommentInput {
  body: string;
  richText?: readonly CommentRichText[];
  parentId?: CommentId;
}
