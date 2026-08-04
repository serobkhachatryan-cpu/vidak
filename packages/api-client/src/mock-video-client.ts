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
import { mockChannels, mockComments, mockPlaylists, mockUserProfiles, mockVideos } from './mock-data.js';
import { createCursorPage } from './pagination.js';
import type { VideoApiClient } from './video-client.js';

export interface MockVideoApiClientOptions {
  delayMs?: number;
  channels?: readonly Channel[];
  comments?: readonly Comment[];
  playlists?: readonly Playlist[];
  userProfiles?: readonly UserProfile[];
  videos?: readonly Video[];
}

export class MockVideoApiClient implements VideoApiClient {
  private readonly delayMs: number;
  private readonly channels: readonly Channel[];
  private readonly comments: readonly Comment[];
  private readonly playlists: readonly Playlist[];
  private readonly userProfiles: readonly UserProfile[];
  private readonly videos: readonly Video[];

  constructor(options: MockVideoApiClientOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.channels = options.channels ?? mockChannels;
    this.comments = options.comments ?? mockComments;
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

  async getPlaylist(id: PlaylistId): Promise<Playlist | undefined> {
    await this.wait();
    return this.playlists.find((playlist) => playlist.id === id);
  }

  async getUserProfile(id: UserProfileId): Promise<UserProfile | undefined> {
    await this.wait();
    return this.userProfiles.find((profile) => profile.id === id);
  }

  async listComments(
    videoId: VideoId,
    pagination: PaginationParams = {},
  ): Promise<CursorPage<Comment>> {
    await this.wait();
    return createCursorPage(
      this.comments.filter((comment) => comment.videoId === videoId && !comment.parentId),
      pagination,
    );
  }

  private filterVideos(filters: VideoListFilters): readonly Video[] {
    const search = filters.search?.trim().toLocaleLowerCase();

    return this.videos.filter((video) => {
      if (filters.channelId && video.channelId !== filters.channelId) return false;
      if (filters.status && video.status !== filters.status) return false;
      if (filters.visibility && video.visibility !== filters.visibility) return false;
      if (search && !`${video.title} ${video.description} ${video.tags.join(' ')}`.toLocaleLowerCase().includes(search)) {
        return false;
      }

      return true;
    });
  }

  private async wait(): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    }
  }
}
