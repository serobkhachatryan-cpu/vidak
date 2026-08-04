import type {
  Channel,
  ChannelId,
  Comment,
  CursorPage,
  PaginationParams,
  Playlist,
  PlaylistId,
  UserProfile,
  UserProfileId,
  Video,
  VideoId,
  VideoListFilters,
} from '@w3ds/types';

export interface VideoApiClient {
  getVideo(id: VideoId): Promise<Video | undefined>;
  listVideos(filters?: VideoListFilters, pagination?: PaginationParams): Promise<CursorPage<Video>>;
  getChannel(id: ChannelId): Promise<Channel | undefined>;
  getPlaylist(id: PlaylistId): Promise<Playlist | undefined>;
  getUserProfile(id: UserProfileId): Promise<UserProfile | undefined>;
  listComments(videoId: VideoId, pagination?: PaginationParams): Promise<CursorPage<Comment>>;
}
