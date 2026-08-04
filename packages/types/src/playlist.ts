import type { ChannelId } from './channel';
import type { VideoId } from './video';

export type PlaylistId = string;
export type PlaylistVisibility = 'public' | 'unlisted' | 'private';

export interface PlaylistItem {
  videoId: VideoId;
  position: number;
  addedAt: string;
}

export interface Playlist {
  id: PlaylistId;
  channelId: ChannelId;
  title: string;
  description?: string;
  visibility: PlaylistVisibility;
  thumbnailUrl?: string;
  items: readonly PlaylistItem[];
  createdAt: string;
  updatedAt: string;
}
