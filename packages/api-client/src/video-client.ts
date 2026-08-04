import type {
  Channel,
  ChannelId,
  Comment,
  CommentId,
  CommentListFilters,
  CommentReaction,
  CreateCommentInput,
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
  listComments(
    videoId: VideoId,
    filters?: CommentListFilters,
    pagination?: PaginationParams,
  ): Promise<CursorPage<Comment>>;
  createComment(videoId: VideoId, input: CreateCommentInput): Promise<Comment>;
  reactToComment(id: CommentId, reaction: CommentReaction | undefined): Promise<Comment>;
}
