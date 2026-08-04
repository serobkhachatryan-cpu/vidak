import type { ChannelId } from './channel';
import type { SearchSort } from './search';

export type VideoId = string;
export type VideoStatus = 'draft' | 'processing' | 'published' | 'archived';
export type VideoVisibility = 'public' | 'unlisted' | 'private';

export const videoCategories = [
  'entertainment',
  'education',
  'gaming',
  'music',
  'science_technology',
  'howto',
  'sports',
  'news',
  'travel',
  'people_blogs',
  'comedy',
  'film_animation',
] as const;

export type VideoCategory = (typeof videoCategories)[number];

export const videoLanguages = ['en', 'es', 'fr', 'de', 'pt', 'ja', 'ko', 'zh', 'ar', 'hi'] as const;

export type VideoLanguage = (typeof videoLanguages)[number];

export interface Video {
  id: VideoId;
  channelId: ChannelId;
  title: string;
  description: string;
  thumbnailUrl: string;
  durationSeconds: number;
  status: VideoStatus;
  visibility: VideoVisibility;
  category?: VideoCategory;
  language?: VideoLanguage;
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
  sort?: SearchSort;
}

export interface VideoUploadProgress {
  bytesUploaded: number;
  bytesTotal: number;
  percent: number;
  bytesPerSecond: number;
  remainingSeconds: number;
}

export interface UploadVideoInput {
  name: string;
  size: number;
  type: string;
}

export interface UploadVideoOptions {
  signal?: AbortSignal;
  onProgress?: (progress: VideoUploadProgress) => void;
}

export interface UploadVideoResult {
  uploadId: string;
  fileName: string;
  durationSeconds: number;
  autoThumbnails: readonly string[];
}

export interface CreateVideoInput {
  channelId: ChannelId;
  uploadId: string;
  title: string;
  description: string;
  tags: readonly string[];
  category: VideoCategory;
  language: VideoLanguage;
  visibility: VideoVisibility;
  thumbnailUrl: string;
  durationSeconds?: number;
  status?: Exclude<VideoStatus, 'archived'>;
}

export interface UpdateVideoInput {
  title?: string;
  description?: string;
  tags?: readonly string[];
  category?: VideoCategory;
  language?: VideoLanguage;
  visibility?: VideoVisibility;
  thumbnailUrl?: string;
  status?: VideoStatus;
}
