import type { ChannelId } from './channel';

export type VideoId = string;
export type VideoStatus = 'draft' | 'processing' | 'published' | 'archived';
export type VideoVisibility = 'public' | 'unlisted' | 'private';

export interface Video {
  id: VideoId;
  channelId: ChannelId;
  title: string;
  description: string;
  thumbnailUrl: string;
  durationSeconds: number;
  status: VideoStatus;
  visibility: VideoVisibility;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  tags: readonly string[];
}

export interface VideoListFilters {
  channelId?: ChannelId;
  status?: VideoStatus;
  visibility?: VideoVisibility;
  search?: string;
}
