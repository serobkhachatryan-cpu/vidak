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
  SearchFilters,
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
  private readonly channels: readonly Channel[];
  private comments: Comment[];
  private readonly currentUserId: UserProfileId;
  private readonly playlists: readonly Playlist[];
  private readonly userProfiles: readonly UserProfile[];
  private readonly videos: readonly Video[];

  constructor(options: MockVideoApiClientOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.channels = options.channels ?? mockChannels;
    this.comments = [...(options.comments ?? mockComments)];
    this.currentUserId = options.currentUserId ?? 'user-grace';
    this.playlists = options.playlists ?? mockPlaylists;
    this.userProfiles = options.userProfiles ?? mockUserProfiles;
    this.videos = options.videos ?? mockVideos;
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
          (filters.parentId === undefined ? !comment.parentId : comment.parentId === filters.parentId),
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

  async reactToComment(
    id: CommentId,
    reaction: CommentReaction | undefined,
  ): Promise<Comment> {
    await this.wait();
    const comment = this.comments.find((item) => item.id === id);
    if (!comment) throw new Error(`Comment ${id} was not found`);
    const previousReaction = comment.viewerReaction;
    const next = {
      ...comment,
      viewerReaction: reaction,
      likeCount:
        comment.likeCount +
        (reaction === 'like' ? 1 : 0) -
        (previousReaction === 'like' ? 1 : 0),
      dislikeCount:
        (comment.dislikeCount ?? 0) +
        (reaction === 'dislike' ? 1 : 0) -
        (previousReaction === 'dislike' ? 1 : 0),
    };
    this.comments = this.comments.map((item) => (item.id === id ? next : item));
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
