import type {
  Channel,
  ChannelId,
  Comment,
  CommentId,
  CommentListFilters,
  CommentReaction,
  ConnectedAccount,
  ConnectedAccountProvider,
  CreateCommentInput,
  CreateVideoDraftInput,
  CreateVideoInput,
  CursorPage,
  DraftMediaAsset,
  PaginationParams,
  Playlist,
  PlaylistId,
  SearchFilters,
  UpdateProfileInput,
  UpdateUserPreferencesInput,
  UpdateVideoDraftInput,
  UpdateVideoInput,
  UploadAvatarInput,
  UploadDraftMediaFile,
  UploadDraftMediaOptions,
  UploadVideoInput,
  UploadVideoOptions,
  UploadVideoResult,
  UserPreferences,
  UserProfile,
  UserProfileId,
  Video,
  VideoId,
  VideoListFilters,
} from '@w3ds/types';

export interface VideoApiClient {
  getVideo(id: VideoId): Promise<Video | undefined>;
  listVideos(filters?: VideoListFilters, pagination?: PaginationParams): Promise<CursorPage<Video>>;
  listChannels(
    filters?: SearchFilters,
    pagination?: PaginationParams,
  ): Promise<CursorPage<Channel>>;
  getChannel(id: ChannelId): Promise<Channel | undefined>;
  listPlaylists(
    filters?: SearchFilters,
    pagination?: PaginationParams,
  ): Promise<CursorPage<Playlist>>;
  getPlaylist(id: PlaylistId): Promise<Playlist | undefined>;
  getUserProfile(id: UserProfileId): Promise<UserProfile | undefined>;
  updateUserProfile(id: UserProfileId, input: UpdateProfileInput): Promise<UserProfile>;
  uploadUserAvatar(id: UserProfileId, input: UploadAvatarInput): Promise<UserProfile>;
  getUserPreferences(id: UserProfileId): Promise<UserPreferences>;
  updateUserPreferences(
    id: UserProfileId,
    input: UpdateUserPreferencesInput,
  ): Promise<UserPreferences>;
  listConnectedAccounts(id: UserProfileId): Promise<readonly ConnectedAccount[]>;
  connectAccount(
    id: UserProfileId,
    provider: ConnectedAccountProvider,
  ): Promise<readonly ConnectedAccount[]>;
  disconnectAccount(
    id: UserProfileId,
    provider: ConnectedAccountProvider,
  ): Promise<readonly ConnectedAccount[]>;
  listComments(
    videoId: VideoId,
    filters?: CommentListFilters,
    pagination?: PaginationParams,
  ): Promise<CursorPage<Comment>>;
  createComment(videoId: VideoId, input: CreateCommentInput): Promise<Comment>;
  reactToComment(id: CommentId, reaction: CommentReaction | undefined): Promise<Comment>;
  uploadVideo(file: UploadVideoInput, options?: UploadVideoOptions): Promise<UploadVideoResult>;
  createVideo(input: CreateVideoInput): Promise<Video>;
  updateVideo(id: VideoId, input: UpdateVideoInput): Promise<Video>;
  publishVideo(id: VideoId): Promise<Video>;
  /** Persist editable draft metadata for the authenticated creator. */
  createDraft(input: CreateVideoDraftInput): Promise<Video>;
  listDrafts(): Promise<readonly Video[]>;
  getDraft(id: VideoId): Promise<Video>;
  updateDraft(id: VideoId, input: UpdateVideoDraftInput): Promise<Video>;
  deleteDraft(id: VideoId): Promise<void>;
  /**
   * Stream-upload raw media bytes into an owned saved draft via the protected
   * media API. Uses cookie session credentials; never exposes tokens or storage keys.
   */
  uploadDraftMedia(
    videoId: VideoId,
    file: UploadDraftMediaFile,
    options?: UploadDraftMediaOptions,
  ): Promise<DraftMediaAsset>;
  /** Read owned draft media metadata (no storage key / public URL). */
  getDraftMedia(videoId: VideoId, assetId: string): Promise<DraftMediaAsset>;
  /** Delete an owned draft media asset through the protected delete route. */
  deleteDraftMedia(videoId: VideoId, assetId: string): Promise<void>;
  /**
   * Same-origin authenticated content path for private preview/download.
   * Not a public media URL — requires the creator session cookie.
   */
  draftMediaContentPath(videoId: VideoId, assetId: string): string;
}
