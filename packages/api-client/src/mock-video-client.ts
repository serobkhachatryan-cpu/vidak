import type {
  Channel,
  ChannelId,
  Comment,
  CommentId,
  CommentListFilters,
  CommentReaction,
  CreateCommentInput,
  CreateVideoInput,
  CursorPage,
  PaginationParams,
  Playlist,
  PlaylistId,
  SearchFilters,
  UpdateVideoInput,
  UploadVideoInput,
  UploadVideoOptions,
  UploadVideoResult,
  UserProfile,
  UserProfileId,
  Video,
  VideoId,
  VideoListFilters,
} from '@w3ds/types';
import {
  mockChannels,
  mockComments,
  mockPlaylists,
  mockUserProfiles,
  mockVideos,
} from './mock-data';
import { createCursorPage } from './pagination';
import type { VideoApiClient } from './video-client';

const autoThumbnailUrls = [
  'https://images.unsplash.com/photo-1558655146-d09347e92766?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1280&h=720&fit=crop',
] as const;

export interface MockVideoApiClientOptions {
  delayMs?: number;
  channels?: readonly Channel[];
  comments?: readonly Comment[];
  currentUserId?: UserProfileId;
  playlists?: readonly Playlist[];
  userProfiles?: readonly UserProfile[];
  videos?: readonly Video[];
}

export class MockVideoApiClient implements VideoApiClient {
  private readonly delayMs: number;
  private channels: Channel[];
  private comments: Comment[];
  private readonly currentUserId: UserProfileId;
  private readonly playlists: readonly Playlist[];
  private readonly userProfiles: readonly UserProfile[];
  private videos: Video[];
  private uploadSequence = 0;
  private readonly completedUploads = new Map<
    string,
    { fileName: string; durationSeconds: number }
  >();

  constructor(options: MockVideoApiClientOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.channels = [...(options.channels ?? mockChannels)];
    this.comments = [...(options.comments ?? mockComments)];
    this.currentUserId = options.currentUserId ?? 'user-grace';
    this.playlists = options.playlists ?? mockPlaylists;
    this.userProfiles = options.userProfiles ?? mockUserProfiles;
    this.videos = [...(options.videos ?? mockVideos)];
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
      ...(status === 'published' ? { publishedAt: now } : {}),
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
    const now = new Date().toISOString();
    const next: Video = {
      ...video,
      status: 'published',
      publishedAt: video.publishedAt ?? now,
      updatedAt: now,
    };
    this.videos = this.videos.map((item) => (item.id === id ? next : item));
    return next;
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

  private async wait(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}
