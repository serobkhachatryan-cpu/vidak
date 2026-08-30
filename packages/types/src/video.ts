import type { ChannelId, PublicChannelProjection } from './channel';
import type { SearchSort } from './search';

export type VideoId = string;
export type VideoStatus = 'draft' | 'processing' | 'published' | 'archived';
export type VideoVisibility = 'public' | 'unlisted' | 'private';

export type VideoMediaRenditionKind = 'original' | 'transcoded';

export interface VideoMediaRendition {
  /** Browser-safe stable id for this public playback option. */
  id: string;
  /** Human-readable quality label, for example "Original" or "720p". */
  label: string;
  /** Same-origin anonymous playback path for this rendition. */
  mediaContentUrl: string;
  kind: VideoMediaRenditionKind;
  contentType?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  bitrateKbps?: number;
  isDefault?: boolean;
}

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

export interface PublicViewRecordResult {
  counted: boolean;
  video: Video;
}

export interface Video {
  id: VideoId;
  channelId: ChannelId;
  /**
   * Safe creator-channel projection for public cards and watch pages.
   * Joined on public discovery/detail so clients never N+1 mock lookups.
   */
  channel?: PublicChannelProjection;
  title: string;
  description: string;
  thumbnailUrl: string;
  durationSeconds: number;
  status: VideoStatus;
  visibility: VideoVisibility;
  category?: VideoCategory;
  language?: VideoLanguage;
  /**
   * Opaque, stable identifier assigned on first publish for later public routes.
   * Preserved across unpublish/republish; omitted until the video has been published once.
   */
  publicVideoId?: string;
  /**
   * Same-origin anonymous playback path for the primary ready media asset.
   * Present only on published `public` / `unlisted` videos that have ready media.
   * Never a storage key, filesystem path, or signed CDN URL.
   */
  mediaContentUrl?: string;
  /**
   * Browser-safe public playback choices. Today this usually contains the
   * uploaded original; future transcoded renditions can be added here without
   * changing the watch page contract.
   */
  mediaRenditions?: readonly VideoMediaRendition[];
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

/** Upload lifecycle for a draft-owned media asset (wire projection). */
export type MediaUploadState = 'pending' | 'uploading' | 'ready' | 'failed';

/**
 * Browser-safe media asset metadata for an owned draft.
 * Omits storage keys, filesystem paths, and public playback URLs.
 */
export interface DraftMediaAsset {
  id: string;
  ownerId: string;
  videoId: VideoId;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  uploadState: MediaUploadState;
  createdAt: string;
  updatedAt: string;
}

/** File metadata + raw body for authenticated draft media upload. */
export interface UploadDraftMediaFile {
  name: string;
  size: number;
  type: string;
  body: Blob;
}

export interface UploadDraftMediaOptions {
  signal?: AbortSignal;
  onProgress?: (progress: VideoUploadProgress) => void;
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

/**
 * Editable metadata for a durable creator video draft.
 * Channel ownership is resolved server-side from the authenticated user.
 * Media upload / publish fields are intentionally omitted.
 */
export interface CreateVideoDraftInput {
  title: string;
  description?: string;
  tags?: readonly string[];
  category?: VideoCategory;
  language?: VideoLanguage;
  visibility?: VideoVisibility;
  thumbnailUrl?: string;
}

/** Partial metadata update for an owned video draft. Cannot publish. */
export interface UpdateVideoDraftInput {
  title?: string;
  description?: string;
  tags?: readonly string[];
  category?: VideoCategory;
  language?: VideoLanguage;
  visibility?: VideoVisibility;
  thumbnailUrl?: string;
}
