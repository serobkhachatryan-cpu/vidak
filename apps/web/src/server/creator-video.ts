import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@w3ds/auth';
import type {
  Channel,
  CreateVideoDraftInput,
  CursorPage,
  PaginationParams,
  UpdateVideoDraftInput,
  Video,
  VideoCategory,
  VideoLanguage,
  VideoVisibility,
} from '@w3ds/types';
import { normalizePersistedThumbnailUrl, videoCategories, videoLanguages } from '@w3ds/types';
import { CreatorVideoError } from './creator-video-errors';
import { type CreatorVideoStore, PostgresCreatorVideoStore } from './creator-video-store';
import { getW3dsDatabase } from './db/client';
import { reportOperationalFailure } from './ops-observability';
import { getW3dsAuthService, W3dsAuthError } from './w3ds-auth';
import type { W3dsPrivateAdapterSyncService } from './w3ds-private-adapter-sync';
import { getVidakPrivateAdapterSyncService } from './w3ds-private-adapter-sync';

export { CreatorVideoError } from './creator-video-errors';
export type { CreatorVideoStore } from './creator-video-store';
export { InMemoryCreatorVideoStore, PostgresCreatorVideoStore } from './creator-video-store';

const visibilityValues = [
  'public',
  'unlisted',
  'private',
] as const satisfies readonly VideoVisibility[];

export interface CreatorVideoServiceOptions {
  store: CreatorVideoStore;
  /**
   * Resolves the authenticated platform user from an access token.
   * Defaults to the shared W3DS auth service.
   */
  resolveUser?: (accessToken: string) => Promise<AuthUser>;
  createId?: () => string;
  /**
   * Optional Vidak-private adapter sync. Defaults to null (no sync).
   * Production wiring via getCreatorVideoService() injects the shared service.
   * Pass `null` explicitly in tests that must not touch sync.
   */
  privateAdapterSync?: W3dsPrivateAdapterSyncService | null;
}

/**
 * Authenticated creator-channel + video-draft domain service.
 * Requires a durable W3DS access session for every operation.
 */
export class CreatorVideoService {
  private readonly store: CreatorVideoStore;
  private readonly resolveUser: (accessToken: string) => Promise<AuthUser>;
  private readonly createId: () => string;
  private readonly privateAdapterSync: W3dsPrivateAdapterSyncService | null;

  constructor(options: CreatorVideoServiceOptions) {
    this.store = options.store;
    this.resolveUser =
      options.resolveUser ??
      (async (accessToken) => {
        const session = await getW3dsAuthService().getSession(accessToken);
        return session.user;
      });
    this.createId = options.createId ?? (() => randomUUID());
    // Default null keeps unit tests isolated. Production wiring uses
    // getCreatorVideoService() which injects getVidakPrivateAdapterSyncService().
    this.privateAdapterSync = options.privateAdapterSync ?? null;
  }

  /** Idempotently provisions the caller's local creator channel. */
  async ensureCreatorChannel(accessToken: string): Promise<Channel> {
    const user = await this.requireUser(accessToken);
    return this.provisionChannel(user);
  }

  async createDraft(accessToken: string, input: CreateVideoDraftInput): Promise<Video> {
    const user = await this.requireUser(accessToken);
    const channel = await this.provisionChannel(user);
    const normalized = normalizeCreateDraftInput(input);
    const draft = await this.store.createDraft({
      id: this.createId(),
      channelId: channel.id,
      ownerId: user.id,
      ...normalized,
    });
    await this.schedulePrivateVideoSync(draft, user.eName);
    return draft;
  }

  async listDrafts(accessToken: string): Promise<Video[]> {
    const user = await this.requireUser(accessToken);
    return this.store.listDraftsByOwnerId(user.id);
  }

  async getDraft(accessToken: string, videoId: string): Promise<Video> {
    const user = await this.requireUser(accessToken);
    const draft = await this.requireOwnedDraft(videoId, user.id);
    return draft;
  }

  async updateDraft(
    accessToken: string,
    videoId: string,
    input: UpdateVideoDraftInput,
  ): Promise<Video> {
    const user = await this.requireUser(accessToken);
    await this.requireOwnedDraft(videoId, user.id);
    const normalized = normalizeUpdateDraftInput(input);
    const updated = await this.store.updateDraft(videoId, user.id, normalized);
    if (!updated) {
      throw new CreatorVideoError('Video draft was not found.', 'not_found', 404);
    }
    await this.schedulePrivateVideoSync(updated, user.eName);
    return updated;
  }

  async deleteDraft(accessToken: string, videoId: string): Promise<void> {
    const user = await this.requireUser(accessToken);
    await this.requireOwnedDraft(videoId, user.id);
    const deleted = await this.store.deleteDraft(videoId, user.id);
    if (!deleted) {
      throw new CreatorVideoError('Video draft was not found.', 'not_found', 404);
    }
  }

  /**
   * Publishes an owned video when it has at least one ready media asset.
   * Idempotent when already published. Assigns a stable `publicVideoId` on
   * first publish. Lifecycle rules live in the store — routes must not
   * re-validate them.
   */
  async publishVideo(accessToken: string, videoId: string): Promise<Video> {
    const user = await this.requireUser(accessToken);
    const normalizedId = videoId.trim();
    if (!normalizedId) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }
    const published = await this.store.publishOwnedVideo(
      normalizedId,
      user.id,
      `pub_${this.createId()}`,
    );
    await this.schedulePrivateVideoSync(published, user.eName);
    return published;
  }

  /**
   * Unpublishes an owned video back to draft. Idempotent when already a draft.
   * Preserves ownership, visibility, media links, and `publicVideoId`.
   */
  async unpublishVideo(accessToken: string, videoId: string): Promise<Video> {
    const user = await this.requireUser(accessToken);
    const normalizedId = videoId.trim();
    if (!normalizedId) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }
    const unpublished = await this.store.unpublishOwnedVideo(normalizedId, user.id);
    await this.schedulePrivateVideoSync(unpublished, user.eName);
    return unpublished;
  }

  /**
   * Anonymous published-video detail by opaque `publicVideoId`.
   * Resolves only `published` videos with `public` or `unlisted` visibility.
   */
  async getPublicVideo(publicVideoId: string): Promise<Video> {
    const normalized = publicVideoId.trim();
    if (!normalized) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }
    const video = await this.store.getPublishedAccessibleByPublicVideoId(normalized);
    if (!video) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }
    return video;
  }

  /**
   * Anonymous discovery page: only `published` + `public` videos.
   * `unlisted`, `private`, and drafts are never included.
   */
  async listPublicVideos(params: PaginationParams = {}): Promise<CursorPage<Video>> {
    const { offset, limit } = normalizePublicPagination(params);
    const rows = await this.store.listPublishedPublicVideos(limit + 1, offset);
    const items = rows.slice(0, limit);
    return {
      items,
      ...(rows.length > limit ? { nextCursor: `offset:${offset + items.length}` } : {}),
    };
  }

  private async requireUser(accessToken: string): Promise<AuthUser> {
    if (!accessToken.trim()) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    try {
      return await this.resolveUser(accessToken);
    } catch (error) {
      if (error instanceof W3dsAuthError) throw error;
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
  }

  private async provisionChannel(user: AuthUser): Promise<Channel> {
    const handle = channelHandleForUser(user);
    const channel = await this.store.findOrCreateChannel({
      id: this.createId(),
      ownerId: user.id,
      handle,
      name: user.displayName.trim() || handle,
      ...(user.profile.avatarUrl || user.avatarUrl
        ? { avatarUrl: user.profile.avatarUrl ?? user.avatarUrl }
        : {}),
    });
    await this.schedulePrivateChannelSync(channel, user.eName);
    return channel;
  }

  /** Fail-soft private projection sync — never blocks product mutations. */
  private async schedulePrivateChannelSync(channel: Channel, ownerEName: string): Promise<void> {
    if (!this.privateAdapterSync) return;
    try {
      await this.privateAdapterSync.syncChannelSafe({ channel, ownerEName });
    } catch (error) {
      reportOperationalFailure({
        category: 'w3ds_sync',
        error,
        code: 'private_adapter_sync',
      });
    }
  }

  private async schedulePrivateVideoSync(video: Video, ownerEName: string): Promise<void> {
    if (!this.privateAdapterSync) return;
    try {
      await this.privateAdapterSync.syncVideoSafe({ video, ownerEName });
    } catch (error) {
      reportOperationalFailure({
        category: 'w3ds_sync',
        error,
        code: 'private_adapter_sync',
      });
    }
  }

  private async requireOwnedDraft(videoId: string, ownerId: string): Promise<Video> {
    if (!videoId.trim()) {
      throw new CreatorVideoError('Video draft was not found.', 'not_found', 404);
    }
    const draft = await this.store.getOwnedDraft(videoId, ownerId);
    if (!draft) {
      throw new CreatorVideoError('Video draft was not found.', 'not_found', 404);
    }
    return draft;
  }
}

let sharedService: CreatorVideoService | undefined;

export function getCreatorVideoService(): CreatorVideoService {
  if (!sharedService) {
    sharedService = new CreatorVideoService({
      store: new PostgresCreatorVideoStore(getW3dsDatabase()),
      privateAdapterSync: getVidakPrivateAdapterSyncService(),
    });
  }
  return sharedService;
}

export function resetCreatorVideoServiceForTests(): void {
  sharedService = undefined;
}

function channelHandleForUser(user: AuthUser): string {
  // Owner-scoped suffix keeps handles unique under the DB unique constraint while
  // remaining stable across idempotent find-or-create calls for the same user.
  const ownerSuffix = user.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'user';
  const fromProfile = user.profile.handle?.trim().replace(/^@/, '').toLocaleLowerCase();
  if (fromProfile && /^[a-z0-9._-]{2,32}$/.test(fromProfile)) {
    return `${fromProfile}-${ownerSuffix}`.slice(0, 48);
  }
  const fromEName = user.eName
    .replace(/^@/, '')
    .replace(/\.w3id$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLocaleLowerCase();
  if (fromEName.length >= 2) {
    return `${fromEName.slice(0, 32)}-${ownerSuffix}`.slice(0, 48);
  }
  return `creator-${ownerSuffix}`;
}

function normalizeCreateDraftInput(input: CreateVideoDraftInput): {
  title: string;
  description: string;
  tags: string[];
  category?: VideoCategory;
  language?: VideoLanguage;
  visibility: VideoVisibility;
  thumbnailUrl: string;
} {
  if (!input || typeof input !== 'object') {
    throw new CreatorVideoError('Title is required.', 'validation_failed', 400);
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) {
    throw new CreatorVideoError('Title is required.', 'validation_failed', 400);
  }
  if (title.length > 100) {
    throw new CreatorVideoError('Title must be 100 characters or fewer.', 'validation_failed', 400);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new CreatorVideoError('Description must be a string.', 'validation_failed', 400);
  }
  const description = typeof input.description === 'string' ? input.description : '';
  if (description.length > 5000) {
    throw new CreatorVideoError(
      'Description must be 5,000 characters or fewer.',
      'validation_failed',
      400,
    );
  }
  const tags = normalizeTags(input.tags);
  const category = normalizeOptionalCategory(input.category);
  const language = normalizeOptionalLanguage(input.language);
  const visibility = normalizeVisibility(input.visibility);
  const thumbnailUrl =
    typeof input.thumbnailUrl === 'string'
      ? normalizePersistedThumbnailUrl(input.thumbnailUrl)
      : input.thumbnailUrl === undefined
        ? ''
        : (() => {
            throw new CreatorVideoError(
              'Thumbnail URL must be a string.',
              'validation_failed',
              400,
            );
          })();

  return {
    title,
    description,
    tags,
    ...(category ? { category } : {}),
    ...(language ? { language } : {}),
    visibility,
    thumbnailUrl,
  };
}

function normalizeUpdateDraftInput(input: UpdateVideoDraftInput): UpdateVideoDraftInput {
  if (!input || typeof input !== 'object') {
    throw new CreatorVideoError('No draft fields were provided.', 'validation_failed', 400);
  }
  const next: UpdateVideoDraftInput = {};
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new CreatorVideoError('Title is required.', 'validation_failed', 400);
    }
    if (input.title.trim().length > 100) {
      throw new CreatorVideoError(
        'Title must be 100 characters or fewer.',
        'validation_failed',
        400,
      );
    }
    next.title = input.title.trim();
  }
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') {
      throw new CreatorVideoError('Description must be a string.', 'validation_failed', 400);
    }
    if (input.description.length > 5000) {
      throw new CreatorVideoError(
        'Description must be 5,000 characters or fewer.',
        'validation_failed',
        400,
      );
    }
    next.description = input.description;
  }
  if (input.tags !== undefined) {
    next.tags = normalizeTags(input.tags);
  }
  if (input.category !== undefined) {
    const category = normalizeOptionalCategory(input.category);
    if (!category) {
      throw new CreatorVideoError('Category is invalid.', 'validation_failed', 400);
    }
    next.category = category;
  }
  if (input.language !== undefined) {
    const language = normalizeOptionalLanguage(input.language);
    if (!language) {
      throw new CreatorVideoError('Language is invalid.', 'validation_failed', 400);
    }
    next.language = language;
  }
  if (input.visibility !== undefined) {
    next.visibility = normalizeVisibility(input.visibility);
  }
  if (input.thumbnailUrl !== undefined) {
    if (typeof input.thumbnailUrl !== 'string') {
      throw new CreatorVideoError('Thumbnail URL must be a string.', 'validation_failed', 400);
    }
    next.thumbnailUrl = normalizePersistedThumbnailUrl(input.thumbnailUrl);
  }
  if (Object.keys(next).length === 0) {
    throw new CreatorVideoError('No draft fields were provided.', 'validation_failed', 400);
  }
  return next;
}

function normalizeTags(tags: CreateVideoDraftInput['tags']): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) {
    throw new CreatorVideoError('Tags must be an array of strings.', 'validation_failed', 400);
  }
  if (tags.length > 20) {
    throw new CreatorVideoError('You can add up to 20 tags.', 'validation_failed', 400);
  }
  const normalized = tags.map((tag) => {
    if (typeof tag !== 'string') {
      throw new CreatorVideoError('Tags must be an array of strings.', 'validation_failed', 400);
    }
    return tag.trim();
  });
  return normalized.filter(Boolean);
}

function normalizeOptionalCategory(value: unknown): VideoCategory | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(videoCategories as readonly string[]).includes(value)) {
    throw new CreatorVideoError('Category is invalid.', 'validation_failed', 400);
  }
  return value as VideoCategory;
}

function normalizeOptionalLanguage(value: unknown): VideoLanguage | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(videoLanguages as readonly string[]).includes(value)) {
    throw new CreatorVideoError('Language is invalid.', 'validation_failed', 400);
  }
  return value as VideoLanguage;
}

function normalizeVisibility(value: unknown): VideoVisibility {
  if (value === undefined || value === null || value === '') return 'private';
  if (typeof value !== 'string' || !(visibilityValues as readonly string[]).includes(value)) {
    throw new CreatorVideoError('Visibility is invalid.', 'validation_failed', 400);
  }
  return value as VideoVisibility;
}

const DEFAULT_PUBLIC_PAGE_SIZE = 20;
const MAX_PUBLIC_PAGE_SIZE = 50;

function normalizePublicPagination(params: PaginationParams): { offset: number; limit: number } {
  const offset = parsePublicCursor(params.cursor);
  let limit = DEFAULT_PUBLIC_PAGE_SIZE;
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    const floored = Math.floor(params.limit);
    if (floored >= 1) {
      limit = Math.min(floored, MAX_PUBLIC_PAGE_SIZE);
    }
  }
  return { offset, limit };
}

/** Opaque `offset:N` cursors; malformed values start at the beginning. */
function parsePublicCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^offset:(\d+)$/.exec(cursor.trim());
  return match ? Number(match[1]) : 0;
}
