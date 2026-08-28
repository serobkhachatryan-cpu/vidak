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
  VideoMediaRendition,
} from '@w3ds/types';
import {
  defaultUserPreferences,
  maxAvatarFileSizeBytes,
  normalizePersistedThumbnailUrl,
  supportedAvatarMimeTypes,
} from '@w3ds/types';
import { draftMediaContentPath, draftThumbnailPath } from './draft-media-path';
import {
  mockChannels,
  mockComments,
  mockPlaylists,
  mockUserProfiles,
  mockVideos,
} from './mock-data';
import { createCursorPage } from './pagination';
import {
  publicMediaContentPath,
  publicPrimaryMediaPath,
  publicThumbnailPath,
} from './public-media-path';
import type { VideoApiClient } from './video-client';

const mockThumbnailMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
const maxMockThumbnailBytes = 5 * 1024 * 1024;

/** Placeholder thumbs for the development mock upload UX only (not from the media API). */
export const mockUploadAutoThumbnails = [
  'https://images.unsplash.com/photo-1558655146-d09347e92766?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1280&h=720&fit=crop',
] as const;

const autoThumbnailUrls = mockUploadAutoThumbnails;

const defaultConnectedAccounts: readonly ConnectedAccount[] = [
  {
    provider: 'google',
    connected: true,
    accountLabel: 'demo@gmail.com',
    connectedAt: '2025-06-12T10:00:00.000Z',
  },
  {
    provider: 'github',
    connected: false,
  },
  {
    provider: 'apple',
    connected: false,
  },
];

export interface MockVideoApiClientOptions {
  delayMs?: number;
  channels?: readonly Channel[];
  comments?: readonly Comment[];
  currentUserId?: UserProfileId;
  playlists?: readonly Playlist[];
  userProfiles?: readonly UserProfile[];
  videos?: readonly Video[];
}

function withSeedPublicIds(videos: readonly Video[]): Video[] {
  return videos.map((video) =>
    video.status === 'published' && !video.publicVideoId
      ? { ...video, publicVideoId: `pub_${video.id.replace(/^video-/, '')}` }
      : { ...video },
  );
}

export class MockVideoApiClient implements VideoApiClient {
  private readonly delayMs: number;
  private channels: Channel[];
  private comments: Comment[];
  private readonly currentUserId: UserProfileId;
  private readonly playlists: readonly Playlist[];
  private userProfiles: UserProfile[];
  private videos: Video[];
  private preferencesByUserId = new Map<UserProfileId, UserPreferences>();
  private connectedAccountsByUserId = new Map<UserProfileId, ConnectedAccount[]>();
  private uploadSequence = 0;
  private mediaSequence = 0;
  private publicIdSequence = 0;
  private readonly completedUploads = new Map<
    string,
    { fileName: string; durationSeconds: number }
  >();
  private readonly draftMediaById = new Map<string, DraftMediaAsset>();

  constructor(options: MockVideoApiClientOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.channels = [...(options.channels ?? mockChannels)];
    this.comments = [...(options.comments ?? mockComments)];
    this.currentUserId = options.currentUserId ?? 'user-grace';
    this.playlists = options.playlists ?? mockPlaylists;
    this.userProfiles = [...(options.userProfiles ?? mockUserProfiles)];
    this.videos = withSeedPublicIds(options.videos ?? mockVideos);
  }

  async getVideo(id: VideoId): Promise<Video | undefined> {
    await this.wait();
    return this.videos.find((video) => video.id === id);
  }

  async listVideos(
    filters: VideoListFilters = {},
    pagination: PaginationParams = {},
  ): Promise<CursorPage<Video>> {
    await this.wait();
    return createCursorPage(this.filterVideos(filters), pagination);
  }

  async getChannel(id: ChannelId): Promise<Channel | undefined> {
    await this.wait();
    return this.channels.find((channel) => channel.id === id);
  }

  async listChannels(
    filters: SearchFilters = {},
    pagination: PaginationParams = {},
  ): Promise<CursorPage<Channel>> {
    await this.wait();
    const search = filters.query?.trim().toLocaleLowerCase();
    const channels = this.channels.filter(
      (channel) =>
        !search ||
        `${channel.name} ${channel.handle} ${channel.description ?? ''}`
          .toLocaleLowerCase()
          .includes(search),
    );
    return createCursorPage(channels, pagination);
  }

  async getPlaylist(id: PlaylistId): Promise<Playlist | undefined> {
    await this.wait();
    return this.playlists.find((playlist) => playlist.id === id);
  }

  async listPlaylists(
    filters: SearchFilters = {},
    pagination: PaginationParams = {},
  ): Promise<CursorPage<Playlist>> {
    await this.wait();
    const search = filters.query?.trim().toLocaleLowerCase();
    const playlists = this.playlists.filter(
      (playlist) =>
        !search ||
        `${playlist.title} ${playlist.description ?? ''}`.toLocaleLowerCase().includes(search),
    );
    return createCursorPage(playlists, pagination);
  }

  async getUserProfile(id: UserProfileId): Promise<UserProfile | undefined> {
    await this.wait();
    return this.userProfiles.find((profile) => profile.id === id);
  }

  /** Creates the local product projection for a newly authenticated W3DS user. */
  async ensureUserProfile(id: UserProfileId): Promise<UserProfile> {
    await this.wait();
    return this.requireProfile(id);
  }

  async updateUserProfile(id: UserProfileId, input: UpdateProfileInput): Promise<UserProfile> {
    await this.wait();
    const profile = this.requireProfile(id);
    const handle = normalizeHandle(input.handle);
    if (!handle) throw new Error('Username is required.');
    if (
      this.userProfiles.some(
        (candidate) => candidate.id !== id && candidate.handle.toLocaleLowerCase() === handle,
      )
    ) {
      throw new Error('That username is already taken.');
    }
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error('Display name is required.');
    const bio = input.bio !== undefined ? input.bio.trim() || undefined : profile.bio;
    const next: UserProfile = {
      id: profile.id,
      handle,
      displayName,
      joinedAt: profile.joinedAt,
      subscriberCount: profile.subscriberCount,
      isVerified: profile.isVerified,
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      ...(profile.bannerUrl ? { bannerUrl: profile.bannerUrl } : {}),
      ...(bio ? { bio } : {}),
      ...(profile.location ? { location: profile.location } : {}),
      ...(profile.websiteUrl ? { websiteUrl: profile.websiteUrl } : {}),
      ...(profile.followingCount !== undefined ? { followingCount: profile.followingCount } : {}),
    };
    this.userProfiles = this.userProfiles.map((item) => (item.id === id ? next : item));
    return next;
  }

  async uploadUserAvatar(id: UserProfileId, input: UploadAvatarInput): Promise<UserProfile> {
    await this.wait();
    const profile = this.requireProfile(id);
    if (!(supportedAvatarMimeTypes as readonly string[]).includes(input.type)) {
      throw new Error('Unsupported avatar format. Use JPG, PNG, or WebP.');
    }
    if (input.size <= 0) throw new Error('The selected avatar is empty.');
    if (input.size > maxAvatarFileSizeBytes) {
      throw new Error('Avatar is too large. Maximum size is 5 MB.');
    }
    const next: UserProfile = {
      ...profile,
      avatarUrl: input.previewUrl,
    };
    this.userProfiles = this.userProfiles.map((item) => (item.id === id ? next : item));
    return next;
  }

  async getUserPreferences(id: UserProfileId): Promise<UserPreferences> {
    await this.wait();
    this.requireProfile(id);
    return this.ensurePreferences(id);
  }

  async updateUserPreferences(
    id: UserProfileId,
    input: UpdateUserPreferencesInput,
  ): Promise<UserPreferences> {
    await this.wait();
    this.requireProfile(id);
    const current = this.ensurePreferences(id);
    const next: UserPreferences = {
      appearance: input.appearance ?? current.appearance,
      language: input.language ?? current.language,
      notifications: {
        ...current.notifications,
        ...input.notifications,
      },
      privacy: {
        ...current.privacy,
        ...input.privacy,
      },
    };
    this.preferencesByUserId.set(id, next);
    return next;
  }

  async listConnectedAccounts(id: UserProfileId): Promise<readonly ConnectedAccount[]> {
    await this.wait();
    this.requireProfile(id);
    return this.ensureConnectedAccounts(id);
  }

  async connectAccount(
    id: UserProfileId,
    provider: ConnectedAccountProvider,
  ): Promise<readonly ConnectedAccount[]> {
    await this.wait();
    this.requireProfile(id);
    const accounts = this.ensureConnectedAccounts(id).map((account) =>
      account.provider === provider
        ? {
            provider,
            connected: true,
            accountLabel: `${provider}-user@example.com`,
            connectedAt: new Date().toISOString(),
          }
        : account,
    );
    this.connectedAccountsByUserId.set(id, accounts);
    return accounts;
  }

  async disconnectAccount(
    id: UserProfileId,
    provider: ConnectedAccountProvider,
  ): Promise<readonly ConnectedAccount[]> {
    await this.wait();
    this.requireProfile(id);
    const accounts = this.ensureConnectedAccounts(id).map((account) =>
      account.provider === provider ? { provider, connected: false } : account,
    );
    this.connectedAccountsByUserId.set(id, accounts);
    return accounts;
  }

  async listComments(
    videoId: VideoId,
    filters: CommentListFilters = {},
    pagination: PaginationParams = {},
  ): Promise<CursorPage<Comment>> {
    await this.wait();
    const comments = this.comments
      .filter(
        (comment) =>
          comment.videoId === videoId &&
          (filters.parentId === undefined
            ? !comment.parentId
            : comment.parentId === filters.parentId),
      )
      .sort((first, second) => {
        if (filters.sort === 'newest') {
          return new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime();
        }
        return second.likeCount - first.likeCount;
      });
    return createCursorPage(comments, pagination);
  }

  async createComment(videoId: VideoId, input: CreateCommentInput): Promise<Comment> {
    await this.wait();
    const comment: Comment = {
      id: `comment-${this.comments.length + 1}`,
      videoId,
      authorId: this.currentUserId,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      body: input.body,
      ...(input.richText ? { richText: input.richText } : {}),
      createdAt: new Date().toISOString(),
      likeCount: 0,
      dislikeCount: 0,
      replyCount: 0,
    };
    this.comments = [...this.comments, comment].map((item) =>
      item.id === input.parentId ? { ...item, replyCount: item.replyCount + 1 } : item,
    );
    return comment;
  }

  async reactToComment(id: CommentId, reaction: CommentReaction | undefined): Promise<Comment> {
    await this.wait();
    const comment = this.comments.find((item) => item.id === id);
    if (!comment) throw new Error(`Comment ${id} was not found`);
    const previousReaction = comment.viewerReaction;
    const next: Comment = {
      ...comment,
      likeCount:
        comment.likeCount + (reaction === 'like' ? 1 : 0) - (previousReaction === 'like' ? 1 : 0),
      dislikeCount:
        (comment.dislikeCount ?? 0) +
        (reaction === 'dislike' ? 1 : 0) -
        (previousReaction === 'dislike' ? 1 : 0),
    };
    if (reaction) next.viewerReaction = reaction;
    else delete next.viewerReaction;
    this.comments = this.comments.map((item) => (item.id === id ? next : item));
    return next;
  }

  async uploadVideo(
    file: UploadVideoInput,
    options: UploadVideoOptions = {},
  ): Promise<UploadVideoResult> {
    const total = Math.max(file.size, 1);
    const steps = 20;
    const chunk = Math.max(Math.floor(total / steps), 1);
    let uploaded = 0;
    const startedAt = Date.now();
    const tickMs = this.delayMs > 0 ? Math.max(Math.floor(this.delayMs / 4), 16) : 16;

    while (uploaded < total) {
      if (options.signal?.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, tickMs));
      uploaded = Math.min(total, uploaded + chunk);
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      const bytesPerSecond = uploaded / elapsedSeconds;
      options.onProgress?.({
        bytesUploaded: uploaded,
        bytesTotal: total,
        percent: Math.round((uploaded / total) * 100),
        bytesPerSecond,
        remainingSeconds: (total - uploaded) / Math.max(bytesPerSecond, 1),
      });
    }

    this.uploadSequence += 1;
    const uploadId = `upload-${this.uploadSequence}`;
    const durationSeconds = Math.max(30, Math.min(900, Math.round(file.size / 250_000)));
    this.completedUploads.set(uploadId, { fileName: file.name, durationSeconds });

    return {
      uploadId,
      fileName: file.name,
      durationSeconds,
      autoThumbnails: autoThumbnailUrls,
    };
  }

  async createVideo(input: CreateVideoInput): Promise<Video> {
    await this.wait();
    const upload = this.completedUploads.get(input.uploadId);
    if (!upload) throw new Error(`Upload ${input.uploadId} was not found`);
    if (!this.channels.some((channel) => channel.id === input.channelId)) {
      throw new Error(`Channel ${input.channelId} was not found`);
    }

    const now = new Date().toISOString();
    const status = input.status ?? 'draft';
    if (status === 'published') this.publicIdSequence += 1;
    const video: Video = {
      id: `video-${this.videos.length + 1}`,
      channelId: input.channelId,
      title: input.title.trim(),
      description: input.description.trim(),
      thumbnailUrl: input.thumbnailUrl,
      durationSeconds: input.durationSeconds ?? upload.durationSeconds,
      status,
      visibility: input.visibility,
      category: input.category,
      language: input.language,
      ...(status === 'published'
        ? {
            publishedAt: now,
            publicVideoId: `pub_mock-${this.publicIdSequence}`,
          }
        : {}),
      createdAt: now,
      updatedAt: now,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: input.tags.map((tag) => tag.trim()).filter(Boolean),
    };

    this.videos = [video, ...this.videos];
    this.channels = this.channels.map((channel) =>
      channel.id === input.channelId ? { ...channel, videoCount: channel.videoCount + 1 } : channel,
    );
    return video;
  }

  async updateVideo(id: VideoId, input: UpdateVideoInput): Promise<Video> {
    await this.wait();
    const video = this.videos.find((item) => item.id === id);
    if (!video) throw new Error(`Video ${id} was not found`);

    const next: Video = {
      ...video,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.tags !== undefined
        ? { tags: input.tags.map((tag) => tag.trim()).filter(Boolean) }
        : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.thumbnailUrl !== undefined ? { thumbnailUrl: input.thumbnailUrl } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.videos = this.videos.map((item) => (item.id === id ? next : item));
    return next;
  }

  async publishVideo(id: VideoId): Promise<Video> {
    await this.wait();
    const video = this.videos.find((item) => item.id === id);
    if (!video) throw new Error(`Video ${id} was not found`);
    const hasReadyMedia = [...this.draftMediaById.values()].some(
      (asset) =>
        asset.videoId === id &&
        asset.uploadState === 'ready' &&
        asset.contentType.startsWith('video/'),
    );
    if (!hasReadyMedia && video.status !== 'published') {
      throw new Error('Publish requires at least one ready media asset.');
    }
    const now = new Date().toISOString();
    this.publicIdSequence += 1;
    const next: Video = {
      ...video,
      status: 'published',
      publicVideoId: video.publicVideoId ?? `pub_mock-${this.publicIdSequence}`,
      publishedAt: video.publishedAt ?? now,
      updatedAt: now,
    };
    const withPlayback = this.withMockMediaContentUrl(next);
    this.videos = this.videos.map((item) => (item.id === id ? withPlayback : item));
    return withPlayback;
  }

  async unpublishVideo(id: VideoId): Promise<Video> {
    await this.wait();
    const video = this.videos.find((item) => item.id === id);
    if (!video) throw new Error(`Video ${id} was not found`);
    const now = new Date().toISOString();
    const { publishedAt: _publishedAt, mediaContentUrl: _mediaContentUrl, ...rest } = video;
    void _publishedAt;
    void _mediaContentUrl;
    const next: Video = {
      ...rest,
      status: 'draft',
      updatedAt: now,
    };
    this.videos = this.videos.map((item) => (item.id === id ? next : item));
    return next;
  }

  async createDraft(input: CreateVideoDraftInput): Promise<Video> {
    await this.wait();
    const channelId = this.channels[0]?.id;
    if (!channelId) throw new Error('No channel is available for drafts');
    const now = new Date().toISOString();
    const video: Video = {
      id: `video-draft-${this.videos.length + 1}`,
      channelId,
      title: input.title.trim(),
      description: (input.description ?? '').trim(),
      thumbnailUrl: normalizePersistedThumbnailUrl(input.thumbnailUrl ?? ''),
      durationSeconds: 0,
      status: 'draft',
      visibility: input.visibility ?? 'private',
      ...(input.category ? { category: input.category } : {}),
      ...(input.language ? { language: input.language } : {}),
      createdAt: now,
      updatedAt: now,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    };
    this.videos = [video, ...this.videos];
    this.channels = this.channels.map((channel) =>
      channel.id === channelId ? { ...channel, videoCount: channel.videoCount + 1 } : channel,
    );
    return video;
  }

  async listDrafts(): Promise<readonly Video[]> {
    await this.wait();
    return this.videos
      .filter((video) => video.status === 'draft')
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listOwnedVideos(): Promise<readonly Video[]> {
    await this.wait();
    return this.videos.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getDraft(id: VideoId): Promise<Video> {
    await this.wait();
    const video = this.videos.find((item) => item.id === id && item.status === 'draft');
    if (!video) throw new Error(`Draft ${id} was not found`);
    return video;
  }

  async updateDraft(id: VideoId, input: UpdateVideoDraftInput): Promise<Video> {
    await this.wait();
    const video = this.videos.find((item) => item.id === id && item.status === 'draft');
    if (!video) throw new Error(`Draft ${id} was not found`);
    const next: Video = {
      ...video,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.tags !== undefined
        ? { tags: input.tags.map((tag) => tag.trim()).filter(Boolean) }
        : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.thumbnailUrl !== undefined
        ? { thumbnailUrl: normalizePersistedThumbnailUrl(input.thumbnailUrl) }
        : {}),
      status: 'draft',
      updatedAt: new Date().toISOString(),
    };
    this.videos = this.videos.map((item) => (item.id === id ? next : item));
    return next;
  }

  async deleteDraft(id: VideoId): Promise<void> {
    await this.wait();
    const video = this.videos.find((item) => item.id === id && item.status === 'draft');
    if (!video) throw new Error(`Draft ${id} was not found`);
    this.videos = this.videos.filter((item) => item.id !== id);
    for (const [assetId, asset] of this.draftMediaById) {
      if (asset.videoId === id) this.draftMediaById.delete(assetId);
    }
    this.channels = this.channels.map((channel) =>
      channel.id === video.channelId
        ? { ...channel, videoCount: Math.max(0, channel.videoCount - 1) }
        : channel,
    );
  }

  async uploadDraftMedia(
    videoId: VideoId,
    file: UploadDraftMediaFile,
    options: UploadDraftMediaOptions = {},
  ): Promise<DraftMediaAsset> {
    const draft = this.videos.find((item) => item.id === videoId && item.status === 'draft');
    if (!draft) throw new Error(`Draft ${videoId} was not found`);

    const total = Math.max(file.size, 1);
    const steps = 20;
    const chunk = Math.max(Math.floor(total / steps), 1);
    let uploaded = 0;
    const startedAt = Date.now();
    const tickMs = this.delayMs > 0 ? Math.max(Math.floor(this.delayMs / 4), 16) : 16;

    while (uploaded < total) {
      if (options.signal?.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, tickMs));
      uploaded = Math.min(total, uploaded + chunk);
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      const bytesPerSecond = uploaded / elapsedSeconds;
      options.onProgress?.({
        bytesUploaded: uploaded,
        bytesTotal: total,
        percent: Math.round((uploaded / total) * 100),
        bytesPerSecond,
        remainingSeconds: (total - uploaded) / Math.max(bytesPerSecond, 1),
      });
    }

    this.mediaSequence += 1;
    const now = new Date().toISOString();
    const asset: DraftMediaAsset = {
      id: `asset-${this.mediaSequence}`,
      ownerId: this.currentUserId,
      videoId,
      originalFilename: file.name,
      contentType: file.type || 'video/mp4',
      byteSize: file.size,
      uploadState: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.draftMediaById.set(asset.id, asset);

    this.uploadSequence += 1;
    const uploadId = `upload-${this.uploadSequence}`;
    const durationSeconds = Math.max(30, Math.min(900, Math.round(file.size / 250_000)));
    this.completedUploads.set(uploadId, { fileName: file.name, durationSeconds });

    return { ...asset };
  }

  async uploadDraftThumbnail(
    videoId: VideoId,
    file: UploadDraftMediaFile,
    options: UploadDraftMediaOptions = {},
  ): Promise<Video> {
    const draft = this.videos.find((item) => item.id === videoId && item.status === 'draft');
    if (!draft) throw new Error(`Draft ${videoId} was not found`);
    if (!(mockThumbnailMimeTypes as readonly string[]).includes(file.type)) {
      throw new Error('Unsupported thumbnail format. Use JPG, PNG, or WebP.');
    }
    if (file.size <= 0) throw new Error('The selected thumbnail is empty.');
    if (file.size > maxMockThumbnailBytes) {
      throw new Error('Thumbnail is too large. Maximum size is 5 MB.');
    }

    if (options.signal?.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }
    options.onProgress?.({
      bytesUploaded: file.size,
      bytesTotal: file.size,
      percent: 100,
      bytesPerSecond: file.size,
      remainingSeconds: 0,
    });

    for (const [assetId, asset] of this.draftMediaById) {
      if (
        asset.videoId === videoId &&
        (mockThumbnailMimeTypes as readonly string[]).includes(asset.contentType)
      ) {
        this.draftMediaById.delete(assetId);
      }
    }

    this.mediaSequence += 1;
    const now = new Date().toISOString();
    const asset: DraftMediaAsset = {
      id: `asset-${this.mediaSequence}`,
      ownerId: this.currentUserId,
      videoId,
      originalFilename: file.name,
      contentType: file.type || 'image/jpeg',
      byteSize: file.size,
      uploadState: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.draftMediaById.set(asset.id, asset);

    const next: Video = {
      ...draft,
      thumbnailUrl: draftThumbnailPath(videoId),
      updatedAt: now,
    };
    this.videos = this.videos.map((item) => (item.id === videoId ? next : item));
    return next;
  }

  async listDraftMedia(videoId: VideoId): Promise<readonly DraftMediaAsset[]> {
    await this.wait();
    return [...this.draftMediaById.values()]
      .filter((asset) => asset.videoId === videoId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getDraftMedia(videoId: VideoId, assetId: string): Promise<DraftMediaAsset> {
    await this.wait();
    const asset = this.draftMediaById.get(assetId);
    if (!asset || asset.videoId !== videoId) {
      throw new Error(`Media asset ${assetId} was not found`);
    }
    return { ...asset };
  }

  async deleteDraftMedia(videoId: VideoId, assetId: string): Promise<void> {
    await this.wait();
    const asset = this.draftMediaById.get(assetId);
    if (!asset || asset.videoId !== videoId) {
      throw new Error(`Media asset ${assetId} was not found`);
    }
    this.draftMediaById.delete(assetId);
  }

  draftMediaContentPath(videoId: VideoId, assetId: string): string {
    return draftMediaContentPath(videoId, assetId);
  }

  draftThumbnailPath(videoId: VideoId): string {
    return draftThumbnailPath(videoId);
  }

  async listPublicVideos(pagination: PaginationParams = {}): Promise<CursorPage<Video>> {
    await this.wait();
    const items = this.videos
      .filter((video) => video.status === 'published' && video.visibility === 'public')
      .slice()
      .sort(
        (first, second) =>
          new Date(second.publishedAt ?? second.createdAt).getTime() -
          new Date(first.publishedAt ?? first.createdAt).getTime(),
      )
      .map((video) => this.withMockMediaContentUrl(video));
    return createCursorPage(items, pagination);
  }

  async getPublicVideo(publicVideoId: string): Promise<Video | undefined> {
    await this.wait();
    const normalized = publicVideoId.trim();
    if (!normalized) return undefined;
    const video = this.videos.find(
      (item) =>
        item.publicVideoId === normalized &&
        item.status === 'published' &&
        (item.visibility === 'public' || item.visibility === 'unlisted'),
    );
    return video ? this.withMockMediaContentUrl(video) : undefined;
  }

  publicMediaContentPath(publicVideoId: string, assetId: string): string {
    return publicMediaContentPath(publicVideoId, assetId);
  }

  async resolvePublicMediaContentPath(publicVideoId: string): Promise<string | undefined> {
    await this.wait();
    const video = await this.getPublicVideo(publicVideoId);
    if (!video?.publicVideoId) return undefined;
    if (video.mediaContentUrl?.trim()) {
      return video.mediaContentUrl.trim();
    }
    const asset = [...this.draftMediaById.values()].find(
      (item) =>
        item.videoId === video.id &&
        item.uploadState === 'ready' &&
        item.contentType.startsWith('video/'),
    );
    return asset ? publicPrimaryMediaPath(video.publicVideoId) : undefined;
  }

  private withMockMediaContentUrl(video: Video): Video {
    let next: Video = {
      ...video,
      thumbnailUrl: normalizePersistedThumbnailUrl(video.thumbnailUrl),
    };

    const publicVideoId = next.publicVideoId;
    if (!publicVideoId || next.status !== 'published') {
      const {
        mediaContentUrl: _mediaContentUrl,
        mediaRenditions: _mediaRenditions,
        ...rest
      } = next;
      void _mediaContentUrl;
      void _mediaRenditions;
      return rest;
    }
    if (next.visibility !== 'public' && next.visibility !== 'unlisted') {
      const {
        mediaContentUrl: _mediaContentUrl,
        mediaRenditions: _mediaRenditions,
        ...rest
      } = next;
      void _mediaContentUrl;
      void _mediaRenditions;
      return rest;
    }

    const readyAssets = [...this.draftMediaById.values()].filter(
      (asset) => asset.videoId === next.id && asset.uploadState === 'ready',
    );
    const readyVideos = readyAssets.filter((asset) => asset.contentType.startsWith('video/'));
    const hasReadyThumbnail = readyAssets.some((asset) =>
      (mockThumbnailMimeTypes as readonly string[]).includes(asset.contentType),
    );

    if (hasReadyThumbnail) {
      next = {
        ...next,
        thumbnailUrl: publicThumbnailPath(publicVideoId),
      };
    }

    if (readyVideos.length === 0) {
      const {
        mediaContentUrl: _mediaContentUrl,
        mediaRenditions: _mediaRenditions,
        ...rest
      } = next;
      void _mediaContentUrl;
      void _mediaRenditions;
      return rest;
    }
    const mediaContentUrl = publicPrimaryMediaPath(publicVideoId);
    return {
      ...next,
      mediaContentUrl,
      mediaRenditions: readyVideos.map((asset, index) =>
        mockMediaRendition(publicVideoId, asset, index),
      ),
    };
  }

  private filterVideos(filters: VideoListFilters): readonly Video[] {
    const search = filters.search?.trim().toLocaleLowerCase();

    const videos = this.videos.filter((video) => {
      if (filters.channelId && video.channelId !== filters.channelId) return false;
      if (filters.status && video.status !== filters.status) return false;
      if (filters.visibility && video.visibility !== filters.visibility) return false;
      if (
        search &&
        !`${video.title} ${video.description} ${video.tags.join(' ')}`
          .toLocaleLowerCase()
          .includes(search)
      ) {
        return false;
      }

      return true;
    });

    if (filters.sort === 'uploadDate') {
      return [...videos].sort(
        (first, second) =>
          new Date(second.publishedAt ?? second.createdAt).getTime() -
          new Date(first.publishedAt ?? first.createdAt).getTime(),
      );
    }
    if (filters.sort === 'views') {
      return [...videos].sort((first, second) => second.viewCount - first.viewCount);
    }
    if (filters.sort === 'relevance' && search) {
      const score = (video: Video) => {
        const title = video.title.toLocaleLowerCase();
        const description = video.description.toLocaleLowerCase();
        const tags = video.tags.join(' ').toLocaleLowerCase();
        if (title === search) return 0;
        if (title.startsWith(search)) return 1;
        if (title.includes(search)) return 2;
        if (tags.includes(search)) return 3;
        if (description.includes(search)) return 4;
        return 5;
      };
      return [...videos].sort((first, second) => score(first) - score(second));
    }
    return videos;
  }

  private requireProfile(id: UserProfileId): UserProfile {
    const profile = this.userProfiles.find((candidate) => candidate.id === id);
    if (profile) return profile;
    const created: UserProfile = {
      id,
      handle: id.replace(/^user-/, ''),
      displayName: 'Creator',
      joinedAt: new Date().toISOString(),
      subscriberCount: 0,
      followingCount: 0,
      isVerified: false,
    };
    this.userProfiles = [...this.userProfiles, created];
    return created;
  }

  private ensurePreferences(id: UserProfileId): UserPreferences {
    const existing = this.preferencesByUserId.get(id);
    if (existing) return existing;
    const created: UserPreferences = {
      appearance: defaultUserPreferences.appearance,
      language: defaultUserPreferences.language,
      notifications: { ...defaultUserPreferences.notifications },
      privacy: { ...defaultUserPreferences.privacy },
    };
    this.preferencesByUserId.set(id, created);
    return created;
  }

  private ensureConnectedAccounts(id: UserProfileId): ConnectedAccount[] {
    const existing = this.connectedAccountsByUserId.get(id);
    if (existing) return existing;
    const created = defaultConnectedAccounts.map((account) => ({ ...account }));
    this.connectedAccountsByUserId.set(id, created);
    return created;
  }

  private async wait(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}

function mockMediaRendition(
  publicVideoId: string,
  asset: DraftMediaAsset,
  index: number,
): VideoMediaRendition {
  const isPrimary = index === 0;
  return {
    id: isPrimary ? 'original' : asset.id,
    label: isPrimary ? 'Original' : mockRenditionLabel(asset, index),
    kind: isPrimary ? 'original' : 'transcoded',
    mediaContentUrl: isPrimary
      ? publicPrimaryMediaPath(publicVideoId)
      : publicMediaContentPath(publicVideoId, asset.id),
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    isDefault: isPrimary,
  };
}

function mockRenditionLabel(asset: DraftMediaAsset, index: number): string {
  const match = asset.originalFilename.match(/(?:^|[^0-9])([1-9][0-9]{2,3})p(?:[^0-9]|$)/i);
  return match?.[1] ? `${match[1]}p` : `Option ${index + 1}`;
}

function normalizeHandle(value: string): string {
  return value
    .trim()
    .replace(/^@/, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}
