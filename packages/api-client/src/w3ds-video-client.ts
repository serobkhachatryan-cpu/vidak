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
  PaginationParams,
  Playlist,
  PlaylistId,
  SearchFilters,
  UpdateProfileInput,
  UpdateUserPreferencesInput,
  UpdateVideoDraftInput,
  UpdateVideoInput,
  UploadAvatarInput,
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
import { MockVideoApiClient, type MockVideoApiClientOptions } from './mock-video-client';
import type { VideoApiClient } from './video-client';

export interface W3dsVideoApiClientOptions {
  /** Origin for platform draft routes. Defaults to same-origin relative paths. */
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Options for the delegated mock client used for non-draft product surfaces
   * (watch/feed/search/settings) until those domains are durable.
   */
  mock?: MockVideoApiClientOptions;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * W3DS video client — cookie-based draft CRUD against `/api/videos/drafts`.
 *
 * Session credentials stay HttpOnly; this client never reads or stores tokens.
 * Non-draft product methods delegate to `MockVideoApiClient` so watch/feed/search
 * behavior remains unchanged in this milestone.
 */
export class W3dsVideoApiClient implements VideoApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly mock: MockVideoApiClient;

  constructor(options: W3dsVideoApiClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? '');
    this.fetchImpl = options.fetch ?? fetch;
    this.mock = new MockVideoApiClient(options.mock);
  }

  getVideo(id: VideoId): Promise<Video | undefined> {
    return this.mock.getVideo(id);
  }

  listVideos(
    filters?: VideoListFilters,
    pagination?: PaginationParams,
  ): Promise<CursorPage<Video>> {
    return this.mock.listVideos(filters, pagination);
  }

  listChannels(
    filters?: SearchFilters,
    pagination?: PaginationParams,
  ): Promise<CursorPage<Channel>> {
    return this.mock.listChannels(filters, pagination);
  }

  getChannel(id: ChannelId): Promise<Channel | undefined> {
    return this.mock.getChannel(id);
  }

  listPlaylists(
    filters?: SearchFilters,
    pagination?: PaginationParams,
  ): Promise<CursorPage<Playlist>> {
    return this.mock.listPlaylists(filters, pagination);
  }

  getPlaylist(id: PlaylistId): Promise<Playlist | undefined> {
    return this.mock.getPlaylist(id);
  }

  getUserProfile(id: UserProfileId): Promise<UserProfile | undefined> {
    return this.mock.getUserProfile(id);
  }

  updateUserProfile(id: UserProfileId, input: UpdateProfileInput): Promise<UserProfile> {
    return this.mock.updateUserProfile(id, input);
  }

  uploadUserAvatar(id: UserProfileId, input: UploadAvatarInput): Promise<UserProfile> {
    return this.mock.uploadUserAvatar(id, input);
  }

  getUserPreferences(id: UserProfileId): Promise<UserPreferences> {
    return this.mock.getUserPreferences(id);
  }

  updateUserPreferences(
    id: UserProfileId,
    input: UpdateUserPreferencesInput,
  ): Promise<UserPreferences> {
    return this.mock.updateUserPreferences(id, input);
  }

  listConnectedAccounts(id: UserProfileId): Promise<readonly ConnectedAccount[]> {
    return this.mock.listConnectedAccounts(id);
  }

  connectAccount(
    id: UserProfileId,
    provider: ConnectedAccountProvider,
  ): Promise<readonly ConnectedAccount[]> {
    return this.mock.connectAccount(id, provider);
  }

  disconnectAccount(
    id: UserProfileId,
    provider: ConnectedAccountProvider,
  ): Promise<readonly ConnectedAccount[]> {
    return this.mock.disconnectAccount(id, provider);
  }

  listComments(
    videoId: VideoId,
    filters?: CommentListFilters,
    pagination?: PaginationParams,
  ): Promise<CursorPage<Comment>> {
    return this.mock.listComments(videoId, filters, pagination);
  }

  createComment(videoId: VideoId, input: CreateCommentInput): Promise<Comment> {
    return this.mock.createComment(videoId, input);
  }

  reactToComment(id: CommentId, reaction: CommentReaction | undefined): Promise<Comment> {
    return this.mock.reactToComment(id, reaction);
  }

  /** Local upload simulation only — durable media ingestion is a later milestone. */
  uploadVideo(file: UploadVideoInput, options?: UploadVideoOptions): Promise<UploadVideoResult> {
    return this.mock.uploadVideo(file, options);
  }

  createVideo(_input: CreateVideoInput): Promise<Video> {
    return Promise.reject(new Error('Publishing is not available yet. Save a draft instead.'));
  }

  updateVideo(id: VideoId, input: UpdateVideoInput): Promise<Video> {
    const { status: _status, ...draftFields } = input;
    return this.updateDraft(id, draftFields);
  }

  publishVideo(_id: VideoId): Promise<Video> {
    return Promise.reject(
      new Error('Publishing requires media ingestion and is not available yet.'),
    );
  }

  async createDraft(input: CreateVideoDraftInput): Promise<Video> {
    return this.requestJson<Video>('/api/videos/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async listDrafts(): Promise<readonly Video[]> {
    const response = await this.requestJson<{ items: Video[] }>('/api/videos/drafts');
    return response.items;
  }

  async getDraft(id: VideoId): Promise<Video> {
    return this.requestJson<Video>(`/api/videos/drafts/${encodeURIComponent(id)}`);
  }

  async updateDraft(id: VideoId, input: UpdateVideoDraftInput): Promise<Video> {
    return this.requestJson<Video>(`/api/videos/drafts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async deleteDraft(id: VideoId): Promise<void> {
    await this.request(`/api/videos/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(this.url(path), {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (response.ok || response.status === 204) return response;

    const body = await readErrorBody(response);
    throw new Error(body.error?.message ?? `Video draft request failed (${response.status})`);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    return {};
  }
}
