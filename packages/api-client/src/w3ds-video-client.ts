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
  VideoUploadProgress,
} from '@w3ds/types';
import {
  draftMediaAssetPath,
  draftMediaContentPath,
  draftMediaUploadPath,
} from './draft-media-path';
import { MockVideoApiClient, type MockVideoApiClientOptions } from './mock-video-client';
import type { VideoApiClient } from './video-client';

export interface W3dsVideoApiClientOptions {
  /** Origin for platform draft/media routes. Defaults to same-origin relative paths. */
  baseUrl?: string;
  /** Injectable fetch for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Injectable XHR factory for upload progress tests. Defaults to
   * `() => new XMLHttpRequest()`.
   */
  createXHR?: () => XMLHttpRequest;
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
 * W3DS video client — cookie-based draft CRUD and protected media transfer
 * against `/api/videos/drafts`.
 *
 * Session credentials stay HttpOnly; this client never reads or stores tokens.
 * Responses never surface storage keys, filesystem paths, or public media URLs.
 * Non-draft product methods delegate to `MockVideoApiClient` so watch/feed/search
 * behavior remains unchanged in this milestone.
 */
export class W3dsVideoApiClient implements VideoApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createXHR: () => XMLHttpRequest;
  private readonly mock: MockVideoApiClient;

  constructor(options: W3dsVideoApiClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? '');
    this.fetchImpl = options.fetch ?? fetch;
    this.createXHR = options.createXHR ?? (() => new XMLHttpRequest());
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

  /**
   * Legacy mock upload simulation — durable ingestion uses `uploadDraftMedia`.
   * Kept so non-media callers and development fixtures remain unchanged.
   */
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

  uploadDraftMedia(
    videoId: VideoId,
    file: UploadDraftMediaFile,
    options: UploadDraftMediaOptions = {},
  ): Promise<DraftMediaAsset> {
    return uploadDraftMediaWithXhr({
      url: this.url(draftMediaUploadPath(videoId)),
      file,
      signal: options.signal,
      onProgress: options.onProgress,
      createXHR: this.createXHR,
    });
  }

  async getDraftMedia(videoId: VideoId, assetId: string): Promise<DraftMediaAsset> {
    return this.requestJson<DraftMediaAsset>(draftMediaAssetPath(videoId, assetId));
  }

  async deleteDraftMedia(videoId: VideoId, assetId: string): Promise<void> {
    await this.request(draftMediaAssetPath(videoId, assetId), { method: 'DELETE' });
  }

  draftMediaContentPath(videoId: VideoId, assetId: string): string {
    return draftMediaContentPath(videoId, assetId);
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

function uploadDraftMediaWithXhr(options: {
  url: string;
  file: UploadDraftMediaFile;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: VideoUploadProgress) => void) | undefined;
  createXHR: () => XMLHttpRequest;
}): Promise<DraftMediaAsset> {
  const { url, file, signal, onProgress, createXHR } = options;

  if (signal?.aborted) {
    return Promise.reject(new DOMException('Upload cancelled', 'AbortError'));
  }

  return new Promise<DraftMediaAsset>((resolve, reject) => {
    const xhr = createXHR();
    const startedAt = Date.now();
    let settled = false;

    const settleReject = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason);
    };

    const settleResolve = (asset: DraftMediaAsset) => {
      if (settled) return;
      settled = true;
      resolve(asset);
    };

    const onAbort = () => {
      xhr.abort();
    };

    signal?.addEventListener('abort', onAbort);

    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Original-Filename', sanitizeOriginalFilename(file.name));
    // Content-Length is set by the browser from the body; it is a forbidden header.

    xhr.upload.onprogress = (event) => {
      const bytesTotal = event.lengthComputable ? event.total : file.size;
      const bytesUploaded = event.loaded;
      const percent =
        bytesTotal > 0 ? Math.min(100, Math.round((bytesUploaded / bytesTotal) * 100)) : 0;
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      const bytesPerSecond = bytesUploaded / elapsedSeconds;
      onProgress?.({
        bytesUploaded,
        bytesTotal,
        percent,
        bytesPerSecond,
        remainingSeconds: (bytesTotal - bytesUploaded) / Math.max(bytesPerSecond, 1),
      });
    };

    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      settleReject(new Error('Network connection lost.'));
    };

    xhr.onabort = () => {
      signal?.removeEventListener('abort', onAbort);
      settleReject(new DOMException('Upload cancelled', 'AbortError'));
    };

    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const asset = JSON.parse(xhr.responseText) as DraftMediaAsset;
          assertPublicMediaAsset(asset);
          onProgress?.({
            bytesUploaded: file.size,
            bytesTotal: file.size,
            percent: 100,
            bytesPerSecond: file.size / Math.max((Date.now() - startedAt) / 1000, 0.001),
            remainingSeconds: 0,
          });
          settleResolve(asset);
        } catch (reason) {
          settleReject(
            reason instanceof Error
              ? reason
              : new Error('Upload succeeded but the response was invalid.'),
          );
        }
        return;
      }

      const message = parseXhrErrorMessage(xhr) ?? `Media upload failed (${xhr.status})`;
      settleReject(new Error(message));
    };

    xhr.send(file.body);
  });
}

function sanitizeOriginalFilename(name: string): string {
  const basename = name.trim().split(/[/\\]/).pop()?.trim() ?? '';
  return basename.slice(0, 512) || 'video.bin';
}

function parseXhrErrorMessage(xhr: XMLHttpRequest): string | undefined {
  try {
    const body = JSON.parse(xhr.responseText) as ApiErrorBody;
    return body.error?.message;
  } catch {
    return undefined;
  }
}

function assertPublicMediaAsset(asset: DraftMediaAsset): void {
  if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string') {
    throw new Error('Invalid media asset response.');
  }
  const record = asset as DraftMediaAsset & {
    storageKey?: unknown;
    path?: unknown;
    publicUrl?: unknown;
  };
  if ('storageKey' in record && record.storageKey !== undefined) {
    throw new Error('Media response included a forbidden storage key.');
  }
  if ('path' in record && record.path !== undefined) {
    throw new Error('Media response included a forbidden filesystem path.');
  }
  if ('publicUrl' in record && record.publicUrl !== undefined) {
    throw new Error('Media response included a forbidden public URL.');
  }
}
