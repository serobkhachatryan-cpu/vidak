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
  /** Publish an owned video (requires ready media). Returns the published Video. */
  publishVideo(id: VideoId): Promise<Video>;
  /** Unpublish an owned video back to draft. Preserves publicVideoId. */
  unpublishVideo(id: VideoId): Promise<Video>;
  /** Persist editable draft metadata for the authenticated creator. */
  createDraft(input: CreateVideoDraftInput): Promise<Video>;
  listDrafts(): Promise<readonly Video[]>;
  /** Every local Vidak video owned by the signed-in creator. */
  listOwnedVideos(): Promise<readonly Video[]>;
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
  /**
   * Stream-upload a thumbnail image into an owned saved draft.
   * Returns the updated Video with a durable same-origin thumbnailUrl
   * (never a blob:/data: URL).
   */
  uploadDraftThumbnail(
    videoId: VideoId,
    file: UploadDraftMediaFile,
    options?: UploadDraftMediaOptions,
  ): Promise<Video>;
  /** List owned video media attached to an editable draft (no storage key / public URL). */
  listDraftMedia(videoId: VideoId): Promise<readonly DraftMediaAsset[]>;
  /** Read owned draft media metadata (no storage key / public URL). */
  getDraftMedia(videoId: VideoId, assetId: string): Promise<DraftMediaAsset>;
  /** Delete an owned draft media asset through the protected delete route. */
  deleteDraftMedia(videoId: VideoId, assetId: string): Promise<void>;
  /**
   * Same-origin authenticated content path for private preview/download.
   * Not a public media URL — requires the creator session cookie.
   */
  draftMediaContentPath(videoId: VideoId, assetId: string): string;
  /** Same-origin authenticated path for a draft thumbnail image. */
  draftThumbnailPath(videoId: VideoId): string;
  /**
   * Anonymous paginated discovery: only `published` + `public` videos.
   * Unlisted, private, and drafts are never included.
   */
  listPublicVideos(pagination?: PaginationParams): Promise<CursorPage<Video>>;
  /**
   * Anonymous published-video detail by opaque `publicVideoId`.
   * Resolves `public` / `unlisted` published videos; drafts and private return undefined.
   */
  getPublicVideo(publicVideoId: string): Promise<Video | undefined>;
  /**
   * Same-origin anonymous content path for a published public/unlisted asset.
   * Uses only opaque publicVideoId + asset id.
   */
  publicMediaContentPath(publicVideoId: string, assetId: string): string;
  /**
   * Resolve a playable public media content path when a ready asset id is known
   * to the client (mock store or upload-session cache). Never invents storage keys.
   */
  resolvePublicMediaContentPath(publicVideoId: string): Promise<string | undefined>;
}
