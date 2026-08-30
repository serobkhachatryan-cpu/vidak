import type {
  Channel,
  PublicChannelProjection,
  UpdateVideoDraftInput,
  Video,
  VideoCategory,
  VideoLanguage,
  VideoVisibility,
} from '@w3ds/types';
import {
  isReplaceableChannelName,
  repairedChannelName,
  toSafePublicChannelProjection,
} from '@w3ds/types';
import { and, desc, eq, exists, ilike, inArray, like, lte, or, sql } from 'drizzle-orm';
import { CreatorVideoError } from './creator-video-errors';
import type { W3dsDatabase } from './db/client';
import {
  creatorChannels,
  mediaAssets,
  videos,
  videoViewEvents,
  w3dsPlatformUsers,
} from './db/schema';
import { PUBLIC_VIEW_DEDUP_WINDOW_MS } from './public-video-views';

export interface CreateChannelRecordInput {
  id: string;
  ownerId: string;
  handle: string;
  name: string;
  description?: string;
  avatarUrl?: string;
}

export interface CreateDraftRecordInput {
  id: string;
  channelId: string;
  ownerId: string;
  title: string;
  description: string;
  tags: readonly string[];
  category?: VideoCategory;
  language?: VideoLanguage;
  visibility: VideoVisibility;
  thumbnailUrl: string;
}

/**
 * Durable persistence for local creator channels and video drafts/published rows.
 * Runtime production uses PostgreSQL; in-memory exists only for unit tests.
 */
export interface CreatorVideoStore {
  /**
   * Inserts a channel for the owner when missing; returns the existing row on conflict.
   */
  findOrCreateChannel(input: CreateChannelRecordInput): Promise<Channel>;
  findChannelByOwnerId(ownerId: string): Promise<Channel | undefined>;
  findChannelById(channelId: string): Promise<Channel | undefined>;
  createDraft(input: CreateDraftRecordInput): Promise<Video>;
  listDraftsByOwnerId(ownerId: string): Promise<Video[]>;
  /** Every local Vidak video the owner can manage, regardless of lifecycle state. */
  listOwnedVideosByOwnerId(ownerId: string): Promise<Video[]>;
  /** Returns the draft only when it exists, is a draft, and is owned by `ownerId`. */
  getOwnedDraft(videoId: string, ownerId: string): Promise<Video | undefined>;
  /** Returns an owned video in any lifecycle state. */
  getOwnedVideo(videoId: string, ownerId: string): Promise<Video | undefined>;
  updateDraft(
    videoId: string,
    ownerId: string,
    input: UpdateVideoDraftInput,
  ): Promise<Video | undefined>;
  deleteDraft(videoId: string, ownerId: string): Promise<boolean>;
  /**
   * Atomically publishes an owned video when it has at least one ready media asset.
   * Idempotent when already published for the owner: returns the existing row
   * unchanged (same `publishedAt` and `publicVideoId`).
   */
  publishOwnedVideo(videoId: string, ownerId: string, publicVideoId: string): Promise<Video>;
  /**
   * Atomically unpublishes an owned video back to draft.
   * Idempotent when already a draft for the owner: returns the existing row
   * unchanged. Clears `publishedAt`; preserves `publicVideoId`, visibility,
   * ownership, createdAt, and media links.
   */
  unpublishOwnedVideo(videoId: string, ownerId: string): Promise<Video>;
  /**
   * Anonymous public detail lookup by opaque `publicVideoId`.
   * Returns only when `status === 'published'` and visibility is `public` or
   * `unlisted`. Drafts and `private` published rows are never returned.
   */
  getPublishedAccessibleByPublicVideoId(publicVideoId: string): Promise<Video | undefined>;
  /**
   * Anonymous discovery listing: `status === 'published'` and
   * `visibility === 'public'` only. Ordered by `publishedAt` descending.
   * Callers page with `limit` / `offset` (fetch `limit + 1` to detect a next page).
   */
  listPublishedPublicVideos(limit: number, offset: number): Promise<Video[]>;
  /**
   * Anonymous channel discovery: channels that have at least one
   * `published` + `public` video. Optional `query` matches name or handle.
   */
  listPublicChannels(limit: number, offset: number, query?: string): Promise<Channel[]>;
  /**
   * Atomically records one anonymous public view when the hashed viewer key is
   * new (or outside the dedup window). Never changes visibility or writes eVault.
   */
  recordPublicView(input: {
    publicVideoId: string;
    viewerKeyHash: string;
    eventId: string;
    now?: Date;
  }): Promise<{ counted: boolean; video: Video }>;
}

function toPublicChannelProjection(
  channel: {
    id: string;
    ownerId?: string;
    name: string;
    handle: string;
    avatarUrl?: string | null;
    subscriberCount: number;
  },
  owner?: {
    id?: string;
    displayName?: string | null;
    eName?: string | null;
    eVaultId?: string | null;
  },
): PublicChannelProjection {
  return toSafePublicChannelProjection({
    id: channel.id,
    name: channel.name,
    handle: channel.handle,
    subscriberCount: channel.subscriberCount,
    ...(channel.avatarUrl ? { avatarUrl: channel.avatarUrl } : {}),
    ...(owner?.displayName !== undefined && owner.displayName !== null
      ? { ownerDisplayName: owner.displayName }
      : {}),
    identity: {
      id: owner?.id ?? channel.ownerId ?? channel.id,
      ...(owner?.eName ? { eName: owner.eName } : {}),
      ...(owner?.eVaultId ? { eVaultId: owner.eVaultId } : {}),
    },
  });
}

function withRepairedChannelName(channel: Channel, nextName: string): Channel {
  if (channel.name === nextName) return channel;
  return { ...channel, name: nextName };
}

function toChannel(row: {
  id: string;
  ownerId: string;
  handle: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  subscriberCount: number;
  videoCount: number;
  createdAt: Date;
}): Channel {
  return {
    id: row.id,
    ownerId: row.ownerId,
    handle: row.handle,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    ...(row.bannerUrl ? { bannerUrl: row.bannerUrl } : {}),
    subscriberCount: row.subscriberCount,
    videoCount: row.videoCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function toVideo(
  row: {
    id: string;
    channelId: string;
    title: string;
    description: string;
    thumbnailUrl: string;
    durationSeconds: number;
    status: Video['status'];
    visibility: VideoVisibility;
    category: VideoCategory | null;
    language: VideoLanguage | null;
    tags: string[];
    viewCount: number;
    likeCount: number;
    commentCount: number;
    publicVideoId: string | null;
    publishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  channel?: PublicChannelProjection,
): Video {
  return {
    id: row.id,
    channelId: row.channelId,
    title: row.title,
    description: row.description,
    thumbnailUrl: row.thumbnailUrl,
    durationSeconds: row.durationSeconds,
    status: row.status,
    visibility: row.visibility,
    ...(row.category ? { category: row.category } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.publicVideoId ? { publicVideoId: row.publicVideoId } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    viewCount: row.viewCount,
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    tags: row.tags,
    ...(channel ? { channel } : {}),
  };
}

function cloneChannel(channel: Channel): Channel {
  return { ...channel };
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function cloneVideo(video: Video): Video {
  return {
    ...video,
    tags: [...video.tags],
    ...(video.channel ? { channel: { ...video.channel } } : {}),
  };
}

type StoredVideo = Video & { ownerId: string };

/** In-memory store for unit tests only — never used as a production fallback. */
export class InMemoryCreatorVideoStore implements CreatorVideoStore {
  private readonly channelsByOwnerId = new Map<string, Channel>();
  private readonly channelsById = new Map<string, Channel>();
  private readonly ownerDisplayNames = new Map<string, string>();
  private readonly videosById = new Map<string, StoredVideo>();
  /** videoId → ready media asset count (test helper for publish preconditions). */
  private readonly readyMediaCounts = new Map<string, number>();
  private readonly viewEvents = new Map<string, Date>();
  private viewMutex: Promise<void> = Promise.resolve();

  /** Test helper: registers that an owned video has a ready media asset attached. */
  seedReadyMediaAsset(videoId: string): void {
    this.readyMediaCounts.set(videoId, (this.readyMediaCounts.get(videoId) ?? 0) + 1);
  }

  /** Test helper: clears ready-media registration for a video. */
  clearReadyMediaAssets(videoId: string): void {
    this.readyMediaCounts.delete(videoId);
  }

  private withPublicChannel(video: Video): Video {
    const channel = this.channelsById.get(video.channelId);
    if (!channel) return cloneVideo(video);
    const ownerDisplayName = this.ownerDisplayNames.get(channel.ownerId);
    return cloneVideo({
      ...video,
      channel: toPublicChannelProjection(
        channel,
        ownerDisplayName
          ? { id: channel.ownerId, displayName: ownerDisplayName }
          : { id: channel.ownerId },
      ),
    });
  }

  /**
   * Test helper: owner public name used when projecting/repairing placeholder
   * channel records that were inserted with technical identifiers.
   */
  seedOwnerDisplayName(ownerId: string, displayName: string): void {
    this.ownerDisplayNames.set(ownerId, displayName);
  }

  private repairPlaceholderChannel(channel: Channel, nextName: string, ownerId: string): Channel {
    if (!isReplaceableChannelName(channel.name, { id: ownerId })) return channel;
    const repaired = withRepairedChannelName(channel, nextName);
    this.channelsByOwnerId.set(ownerId, repaired);
    this.channelsById.set(repaired.id, repaired);
    return repaired;
  }

  private enqueueView<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.viewMutex.then(fn, fn);
    this.viewMutex = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async findOrCreateChannel(input: CreateChannelRecordInput): Promise<Channel> {
    const existing = this.channelsByOwnerId.get(input.ownerId);
    if (existing) {
      return cloneChannel(this.repairPlaceholderChannel(existing, input.name, input.ownerId));
    }
    const channel: Channel = {
      id: input.id,
      ownerId: input.ownerId,
      handle: input.handle,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
      subscriberCount: 0,
      videoCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.channelsByOwnerId.set(input.ownerId, channel);
    this.channelsById.set(channel.id, channel);
    return cloneChannel(channel);
  }

  async findChannelByOwnerId(ownerId: string): Promise<Channel | undefined> {
    const channel = this.channelsByOwnerId.get(ownerId);
    return channel ? cloneChannel(channel) : undefined;
  }

  async findChannelById(channelId: string): Promise<Channel | undefined> {
    const channel = this.channelsById.get(channelId);
    if (!channel) return undefined;
    const ownerName = this.ownerDisplayNames.get(channel.ownerId);
    if (ownerName && isReplaceableChannelName(channel.name, { id: channel.ownerId })) {
      const next = repairedChannelName({
        storedName: channel.name,
        ownerDisplayName: ownerName,
        identity: { id: channel.ownerId },
      });
      return cloneChannel(this.repairPlaceholderChannel(channel, next.name, channel.ownerId));
    }
    return cloneChannel(channel);
  }

  async createDraft(input: CreateDraftRecordInput): Promise<Video> {
    const channel = this.channelsById.get(input.channelId);
    if (!channel) {
      throw new CreatorVideoError('Creator channel was not found.', 'not_found', 404);
    }
    const now = new Date().toISOString();
    const video: StoredVideo = {
      id: input.id,
      channelId: input.channelId,
      ownerId: input.ownerId,
      title: input.title,
      description: input.description,
      thumbnailUrl: input.thumbnailUrl,
      durationSeconds: 0,
      status: 'draft',
      visibility: input.visibility,
      ...(input.category ? { category: input.category } : {}),
      ...(input.language ? { language: input.language } : {}),
      createdAt: now,
      updatedAt: now,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      tags: [...input.tags],
    };
    this.videosById.set(video.id, video);
    const nextChannel: Channel = { ...channel, videoCount: channel.videoCount + 1 };
    this.channelsById.set(nextChannel.id, nextChannel);
    this.channelsByOwnerId.set(nextChannel.ownerId, nextChannel);
    return cloneVideo(video);
  }

  async listDraftsByOwnerId(ownerId: string): Promise<Video[]> {
    return [...this.videosById.values()]
      .filter((draft) => draft.ownerId === ownerId && draft.status === 'draft')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneVideo);
  }

  async listOwnedVideosByOwnerId(ownerId: string): Promise<Video[]> {
    return [...this.videosById.values()]
      .filter((video) => video.ownerId === ownerId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneVideo);
  }

  async getOwnedDraft(videoId: string, ownerId: string): Promise<Video | undefined> {
    const draft = this.videosById.get(videoId);
    if (!draft || draft.ownerId !== ownerId || draft.status !== 'draft') return undefined;
    return cloneVideo(draft);
  }

  async getOwnedVideo(videoId: string, ownerId: string): Promise<Video | undefined> {
    const video = this.videosById.get(videoId);
    if (!video || video.ownerId !== ownerId) return undefined;
    return cloneVideo(video);
  }

  async updateDraft(
    videoId: string,
    ownerId: string,
    input: UpdateVideoDraftInput,
  ): Promise<Video | undefined> {
    const existing = this.videosById.get(videoId);
    if (!existing || existing.ownerId !== ownerId || existing.status !== 'draft') {
      return undefined;
    }
    const next: StoredVideo = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.thumbnailUrl !== undefined ? { thumbnailUrl: input.thumbnailUrl } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.videosById.set(videoId, next);
    return cloneVideo(next);
  }

  async deleteDraft(videoId: string, ownerId: string): Promise<boolean> {
    const existing = this.videosById.get(videoId);
    if (!existing || existing.ownerId !== ownerId || existing.status !== 'draft') {
      return false;
    }
    this.videosById.delete(videoId);
    this.readyMediaCounts.delete(videoId);
    const channel = this.channelsById.get(existing.channelId);
    if (channel) {
      const nextChannel: Channel = {
        ...channel,
        videoCount: Math.max(0, channel.videoCount - 1),
      };
      this.channelsById.set(nextChannel.id, nextChannel);
      this.channelsByOwnerId.set(nextChannel.ownerId, nextChannel);
    }
    return true;
  }

  async publishOwnedVideo(videoId: string, ownerId: string, publicVideoId: string): Promise<Video> {
    const normalizedId = videoId.trim();
    const normalizedPublicId = publicVideoId.trim();
    if (!normalizedId) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }
    if (!normalizedPublicId) {
      throw new CreatorVideoError('Public video id is required.', 'validation_failed', 400);
    }

    const existing = this.videosById.get(normalizedId);
    if (!existing || existing.ownerId !== ownerId) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }
    if (existing.status === 'published') {
      return cloneVideo(existing);
    }
    if (existing.status !== 'draft') {
      throw new CreatorVideoError(
        'Video cannot be published from its current state.',
        'invalid_transition',
        409,
      );
    }
    if ((this.readyMediaCounts.get(normalizedId) ?? 0) < 1) {
      throw new CreatorVideoError(
        'Video cannot be published without at least one ready media asset.',
        'precondition_failed',
        409,
      );
    }

    const now = new Date().toISOString();
    const next: StoredVideo = {
      ...existing,
      status: 'published',
      publicVideoId: existing.publicVideoId ?? normalizedPublicId,
      publishedAt: existing.publishedAt ?? now,
      updatedAt: now,
    };
    this.videosById.set(normalizedId, next);
    return cloneVideo(next);
  }

  async unpublishOwnedVideo(videoId: string, ownerId: string): Promise<Video> {
    const normalizedId = videoId.trim();
    if (!normalizedId) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }

    const existing = this.videosById.get(normalizedId);
    if (!existing || existing.ownerId !== ownerId) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }
    if (existing.status === 'draft') {
      return cloneVideo(existing);
    }
    if (existing.status !== 'published') {
      throw new CreatorVideoError(
        'Video cannot be unpublished from its current state.',
        'invalid_transition',
        409,
      );
    }

    const now = new Date().toISOString();
    const { publishedAt: _publishedAt, ...rest } = existing;
    void _publishedAt;
    const next: StoredVideo = {
      ...rest,
      status: 'draft',
      updatedAt: now,
    };
    this.videosById.set(normalizedId, next);
    return cloneVideo(next);
  }

  async getPublishedAccessibleByPublicVideoId(publicVideoId: string): Promise<Video | undefined> {
    const normalized = publicVideoId.trim();
    if (!normalized) return undefined;
    const match = [...this.videosById.values()].find(
      (video) =>
        video.publicVideoId === normalized &&
        video.status === 'published' &&
        (video.visibility === 'public' || video.visibility === 'unlisted'),
    );
    return match ? this.withPublicChannel(match) : undefined;
  }

  async listPublishedPublicVideos(limit: number, offset: number): Promise<Video[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    const safeOffset = Math.max(0, Math.floor(offset));
    if (safeLimit === 0) return [];
    return [...this.videosById.values()]
      .filter((video) => video.status === 'published' && video.visibility === 'public')
      .sort((left, right) => {
        const leftPublished = left.publishedAt ?? left.createdAt;
        const rightPublished = right.publishedAt ?? right.createdAt;
        const byPublished = rightPublished.localeCompare(leftPublished);
        if (byPublished !== 0) return byPublished;
        return right.id.localeCompare(left.id);
      })
      .slice(safeOffset, safeOffset + safeLimit)
      .map((video) => this.withPublicChannel(video));
  }

  async listPublicChannels(limit: number, offset: number, query?: string): Promise<Channel[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    const safeOffset = Math.max(0, Math.floor(offset));
    if (safeLimit === 0) return [];
    const needle = query?.trim().toLocaleLowerCase();
    const publicChannelIds = new Set(
      [...this.videosById.values()]
        .filter((video) => video.status === 'published' && video.visibility === 'public')
        .map((video) => video.channelId),
    );
    const channels = [...this.channelsById.values()]
      .filter((channel) => publicChannelIds.has(channel.id))
      .filter((channel) => {
        if (!needle) return true;
        return (
          channel.name.toLocaleLowerCase().includes(needle) ||
          channel.handle.toLocaleLowerCase().includes(needle)
        );
      })
      .sort((left, right) => {
        const byName = left.name.localeCompare(right.name);
        return byName !== 0 ? byName : left.id.localeCompare(right.id);
      })
      .slice(safeOffset, safeOffset + safeLimit);
    const projected: Channel[] = [];
    for (const channel of channels) {
      const found = await this.findChannelById(channel.id);
      if (found) projected.push(found);
    }
    return projected;
  }

  async recordPublicView(input: {
    publicVideoId: string;
    viewerKeyHash: string;
    eventId: string;
    now?: Date;
  }): Promise<{ counted: boolean; video: Video }> {
    return this.enqueueView(async () => {
      const video = await this.getPublishedAccessibleByPublicVideoId(input.publicVideoId);
      if (!video) {
        throw new CreatorVideoError('Video was not found.', 'not_found', 404);
      }
      const stored = this.videosById.get(video.id);
      if (!stored?.publicVideoId) {
        throw new CreatorVideoError('Video was not found.', 'not_found', 404);
      }
      const now = input.now ?? new Date();
      const key = `${stored.publicVideoId}:${input.viewerKeyHash}`;
      const previous = this.viewEvents.get(key);
      if (previous && now.getTime() - previous.getTime() < PUBLIC_VIEW_DEDUP_WINDOW_MS) {
        return { counted: false, video: this.withPublicChannel(stored) };
      }
      this.viewEvents.set(key, now);
      stored.viewCount += 1;
      void input.eventId;
      return { counted: true, video: this.withPublicChannel(stored) };
    });
  }
}

/** PostgreSQL-backed store shared across application instances. */
export class PostgresCreatorVideoStore implements CreatorVideoStore {
  constructor(private readonly db: W3dsDatabase) {}

  async findOrCreateChannel(input: CreateChannelRecordInput): Promise<Channel> {
    const now = new Date();
    const inserted = await this.db
      .insert(creatorChannels)
      .values({
        id: input.id,
        ownerId: input.ownerId,
        handle: input.handle,
        name: input.name,
        description: input.description ?? null,
        avatarUrl: input.avatarUrl ?? null,
        bannerUrl: null,
        subscriberCount: 0,
        videoCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: creatorChannels.ownerId })
      .returning();
    if (inserted[0]) return toChannel(inserted[0]);
    const existing = await this.findChannelByOwnerId(input.ownerId);
    if (!existing) {
      throw new CreatorVideoError('Failed to persist creator channel.', 'internal_error', 500);
    }
    return this.repairPlaceholderChannelName(existing, input.name);
  }

  async findChannelByOwnerId(ownerId: string): Promise<Channel | undefined> {
    const [row] = await this.db
      .select()
      .from(creatorChannels)
      .where(eq(creatorChannels.ownerId, ownerId))
      .limit(1);
    return row ? toChannel(row) : undefined;
  }

  async findChannelById(channelId: string): Promise<Channel | undefined> {
    const normalized = channelId.trim();
    if (!normalized) return undefined;
    const [row] = await this.db
      .select({ channel: creatorChannels, owner: w3dsPlatformUsers })
      .from(creatorChannels)
      .leftJoin(w3dsPlatformUsers, eq(creatorChannels.ownerId, w3dsPlatformUsers.id))
      .where(eq(creatorChannels.id, normalized))
      .limit(1);
    if (!row) return undefined;
    const next = repairedChannelName({
      storedName: row.channel.name,
      ...(row.owner?.displayName !== undefined ? { ownerDisplayName: row.owner.displayName } : {}),
      identity: {
        id: row.owner?.id ?? row.channel.ownerId,
        ...(row.owner?.eName ? { eName: row.owner.eName } : {}),
        ...(row.owner?.eVaultId ? { eVaultId: row.owner.eVaultId } : {}),
      },
    });
    return this.repairPlaceholderChannelName(toChannel(row.channel), next.name);
  }

  private async repairPlaceholderChannelName(channel: Channel, nextName: string): Promise<Channel> {
    if (!isReplaceableChannelName(channel.name, { id: channel.ownerId })) return channel;
    const name = nextName.trim();
    if (!name || name === channel.name) return channel;
    const [row] = await this.db
      .update(creatorChannels)
      .set({ name, updatedAt: new Date() })
      .where(eq(creatorChannels.id, channel.id))
      .returning();
    return row ? toChannel(row) : withRepairedChannelName(channel, name);
  }

  async createDraft(input: CreateDraftRecordInput): Promise<Video> {
    const now = new Date();
    const [row] = await this.db
      .insert(videos)
      .values({
        id: input.id,
        channelId: input.channelId,
        ownerId: input.ownerId,
        title: input.title,
        description: input.description,
        thumbnailUrl: input.thumbnailUrl,
        durationSeconds: 0,
        status: 'draft',
        visibility: input.visibility,
        category: input.category ?? null,
        language: input.language ?? null,
        tags: [...input.tags],
        viewCount: 0,
        likeCount: 0,
        commentCount: 0,
        publicVideoId: null,
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new CreatorVideoError('Failed to create video draft.', 'internal_error', 500);
    }
    await this.db
      .update(creatorChannels)
      .set({
        videoCount: sql`${creatorChannels.videoCount} + 1`,
        updatedAt: now,
      })
      .where(eq(creatorChannels.id, input.channelId));
    return toVideo(row);
  }

  async listDraftsByOwnerId(ownerId: string): Promise<Video[]> {
    const rows = await this.db
      .select()
      .from(videos)
      .where(and(eq(videos.ownerId, ownerId), eq(videos.status, 'draft')))
      .orderBy(desc(videos.updatedAt));
    return rows.map((row) => toVideo(row));
  }

  async listOwnedVideosByOwnerId(ownerId: string): Promise<Video[]> {
    const rows = await this.db
      .select()
      .from(videos)
      .where(eq(videos.ownerId, ownerId))
      .orderBy(desc(videos.updatedAt));
    return rows.map((row) => toVideo(row));
  }

  async getOwnedDraft(videoId: string, ownerId: string): Promise<Video | undefined> {
    const [row] = await this.db
      .select()
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.ownerId, ownerId), eq(videos.status, 'draft')))
      .limit(1);
    return row ? toVideo(row) : undefined;
  }

  async getOwnedVideo(videoId: string, ownerId: string): Promise<Video | undefined> {
    const [row] = await this.db
      .select()
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.ownerId, ownerId)))
      .limit(1);
    return row ? toVideo(row) : undefined;
  }

  async updateDraft(
    videoId: string,
    ownerId: string,
    input: UpdateVideoDraftInput,
  ): Promise<Video | undefined> {
    const existing = await this.db
      .select()
      .from(videos)
      .where(and(eq(videos.id, videoId), eq(videos.ownerId, ownerId), eq(videos.status, 'draft')))
      .limit(1);
    if (!existing[0]) return undefined;

    const now = new Date();
    const [row] = await this.db
      .update(videos)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.thumbnailUrl !== undefined ? { thumbnailUrl: input.thumbnailUrl } : {}),
        updatedAt: now,
      })
      .where(and(eq(videos.id, videoId), eq(videos.ownerId, ownerId), eq(videos.status, 'draft')))
      .returning();
    return row ? toVideo(row) : undefined;
  }

  async deleteDraft(videoId: string, ownerId: string): Promise<boolean> {
    const [row] = await this.db
      .delete(videos)
      .where(and(eq(videos.id, videoId), eq(videos.ownerId, ownerId), eq(videos.status, 'draft')))
      .returning();
    if (!row) return false;
    await this.db
      .update(creatorChannels)
      .set({
        videoCount: sql`GREATEST(${creatorChannels.videoCount} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(creatorChannels.id, row.channelId));
    return true;
  }

  async publishOwnedVideo(videoId: string, ownerId: string, publicVideoId: string): Promise<Video> {
    const normalizedId = videoId.trim();
    const normalizedPublicId = publicVideoId.trim();
    if (!normalizedId) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }
    if (!normalizedPublicId) {
      throw new CreatorVideoError('Public video id is required.', 'validation_failed', 400);
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(videos)
        .where(and(eq(videos.id, normalizedId), eq(videos.ownerId, ownerId)))
        .limit(1);
      if (!existing) {
        throw new CreatorVideoError('Video was not found.', 'not_found', 404);
      }
      if (existing.status === 'published') {
        return toVideo(existing);
      }
      if (existing.status !== 'draft') {
        throw new CreatorVideoError(
          'Video cannot be published from its current state.',
          'invalid_transition',
          409,
        );
      }

      const [readyAsset] = await tx
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.videoId, normalizedId),
            eq(mediaAssets.ownerId, ownerId),
            eq(mediaAssets.uploadState, 'ready'),
            like(mediaAssets.contentType, 'video/%'),
          ),
        )
        .limit(1);
      if (!readyAsset) {
        throw new CreatorVideoError(
          'Video cannot be published without at least one ready media asset.',
          'precondition_failed',
          409,
        );
      }

      const now = new Date();
      const [row] = await tx
        .update(videos)
        .set({
          status: 'published',
          publishedAt: existing.publishedAt ?? now,
          publicVideoId: existing.publicVideoId ?? normalizedPublicId,
          updatedAt: now,
        })
        .where(
          and(eq(videos.id, normalizedId), eq(videos.ownerId, ownerId), eq(videos.status, 'draft')),
        )
        .returning();
      if (row) return toVideo(row);

      // Concurrent publish won the race — return the published row if present.
      const [again] = await tx
        .select()
        .from(videos)
        .where(and(eq(videos.id, normalizedId), eq(videos.ownerId, ownerId)))
        .limit(1);
      if (again?.status === 'published') return toVideo(again);
      throw new CreatorVideoError('Failed to publish video.', 'internal_error', 500);
    });
  }

  async unpublishOwnedVideo(videoId: string, ownerId: string): Promise<Video> {
    const normalizedId = videoId.trim();
    if (!normalizedId) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(videos)
        .where(and(eq(videos.id, normalizedId), eq(videos.ownerId, ownerId)))
        .limit(1);
      if (!existing) {
        throw new CreatorVideoError('Video was not found.', 'not_found', 404);
      }
      if (existing.status === 'draft') {
        return toVideo(existing);
      }
      if (existing.status !== 'published') {
        throw new CreatorVideoError(
          'Video cannot be unpublished from its current state.',
          'invalid_transition',
          409,
        );
      }

      const now = new Date();
      const [row] = await tx
        .update(videos)
        .set({
          status: 'draft',
          publishedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(videos.id, normalizedId),
            eq(videos.ownerId, ownerId),
            eq(videos.status, 'published'),
          ),
        )
        .returning();
      if (row) return toVideo(row);

      const [again] = await tx
        .select()
        .from(videos)
        .where(and(eq(videos.id, normalizedId), eq(videos.ownerId, ownerId)))
        .limit(1);
      if (again?.status === 'draft') return toVideo(again);
      throw new CreatorVideoError('Failed to unpublish video.', 'internal_error', 500);
    });
  }

  async getPublishedAccessibleByPublicVideoId(publicVideoId: string): Promise<Video | undefined> {
    const normalized = publicVideoId.trim();
    if (!normalized) return undefined;
    const [row] = await this.db
      .select({ video: videos, channel: creatorChannels, owner: w3dsPlatformUsers })
      .from(videos)
      .innerJoin(creatorChannels, eq(videos.channelId, creatorChannels.id))
      .innerJoin(w3dsPlatformUsers, eq(creatorChannels.ownerId, w3dsPlatformUsers.id))
      .where(
        and(
          eq(videos.publicVideoId, normalized),
          eq(videos.status, 'published'),
          inArray(videos.visibility, ['public', 'unlisted']),
        ),
      )
      .limit(1);
    return row ? toVideo(row.video, toPublicChannelProjection(row.channel, row.owner)) : undefined;
  }

  async listPublishedPublicVideos(limit: number, offset: number): Promise<Video[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    const safeOffset = Math.max(0, Math.floor(offset));
    if (safeLimit === 0) return [];
    const rows = await this.db
      .select({ video: videos, channel: creatorChannels, owner: w3dsPlatformUsers })
      .from(videos)
      .innerJoin(creatorChannels, eq(videos.channelId, creatorChannels.id))
      .innerJoin(w3dsPlatformUsers, eq(creatorChannels.ownerId, w3dsPlatformUsers.id))
      .where(and(eq(videos.status, 'published'), eq(videos.visibility, 'public')))
      .orderBy(desc(videos.publishedAt), desc(videos.id))
      .limit(safeLimit)
      .offset(safeOffset);
    return rows.map((row) => toVideo(row.video, toPublicChannelProjection(row.channel, row.owner)));
  }

  async listPublicChannels(limit: number, offset: number, query?: string): Promise<Channel[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    const safeOffset = Math.max(0, Math.floor(offset));
    if (safeLimit === 0) return [];
    const needle = query?.trim();
    const publishedPublicVideo = exists(
      this.db
        .select({ id: videos.id })
        .from(videos)
        .where(
          and(
            eq(videos.channelId, creatorChannels.id),
            eq(videos.status, 'published'),
            eq(videos.visibility, 'public'),
          ),
        ),
    );
    const search =
      needle && needle.length > 0
        ? or(
            ilike(creatorChannels.name, likeContains(needle)),
            ilike(creatorChannels.handle, likeContains(needle)),
          )
        : undefined;
    const rows = await this.db
      .select({ channel: creatorChannels, owner: w3dsPlatformUsers })
      .from(creatorChannels)
      .innerJoin(w3dsPlatformUsers, eq(creatorChannels.ownerId, w3dsPlatformUsers.id))
      .where(search ? and(publishedPublicVideo, search) : publishedPublicVideo)
      .orderBy(creatorChannels.name, creatorChannels.id)
      .limit(safeLimit)
      .offset(safeOffset);
    return rows.map((row) => {
      const channel = toChannel(row.channel);
      const projection = toPublicChannelProjection(row.channel, row.owner);
      return {
        ...channel,
        name: projection.name,
        handle: projection.handle,
        ...(projection.avatarUrl ? { avatarUrl: projection.avatarUrl } : {}),
      };
    });
  }

  async recordPublicView(input: {
    publicVideoId: string;
    viewerKeyHash: string;
    eventId: string;
    now?: Date;
  }): Promise<{ counted: boolean; video: Video }> {
    const normalized = input.publicVideoId.trim();
    const viewerKeyHash = input.viewerKeyHash.trim();
    if (!normalized || !viewerKeyHash) {
      throw new CreatorVideoError('Video was not found.', 'not_found', 404);
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ video: videos, channel: creatorChannels })
        .from(videos)
        .innerJoin(creatorChannels, eq(videos.channelId, creatorChannels.id))
        .where(
          and(
            eq(videos.publicVideoId, normalized),
            eq(videos.status, 'published'),
            inArray(videos.visibility, ['public', 'unlisted']),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new CreatorVideoError('Video was not found.', 'not_found', 404);
      }

      const now = input.now ?? new Date();
      const cutoff = new Date(now.getTime() - PUBLIC_VIEW_DEDUP_WINDOW_MS);
      const [event] = await tx
        .insert(videoViewEvents)
        .values({
          id: input.eventId,
          videoId: existing.video.id,
          publicVideoId: existing.video.publicVideoId ?? normalized,
          viewerKeyHash,
          countedAt: now,
        })
        .onConflictDoUpdate({
          target: [videoViewEvents.publicVideoId, videoViewEvents.viewerKeyHash],
          set: { countedAt: now },
          setWhere: lte(videoViewEvents.countedAt, cutoff),
        })
        .returning({ id: videoViewEvents.id });

      if (!event) {
        return {
          counted: false,
          video: toVideo(existing.video, toPublicChannelProjection(existing.channel)),
        };
      }

      const [updated] = await tx
        .update(videos)
        .set({
          viewCount: sql`${videos.viewCount} + 1`,
        })
        .where(eq(videos.id, existing.video.id))
        .returning();
      if (!updated) {
        throw new CreatorVideoError('Failed to record the view.', 'internal_error', 500);
      }
      return {
        counted: true,
        video: toVideo(updated, toPublicChannelProjection(existing.channel)),
      };
    });
  }
}

/**
 * One-shot repair for channels whose stored name is still a technical
 * placeholder. Uses the owner's chosen/verified public name when safe;
 * otherwise "Vidak channel". Never overwrites a genuinely chosen name.
 */
export async function repairPlaceholderCreatorChannelNames(db: W3dsDatabase): Promise<number> {
  const rows = await db
    .select({
      channel: creatorChannels,
      owner: w3dsPlatformUsers,
    })
    .from(creatorChannels)
    .innerJoin(w3dsPlatformUsers, eq(creatorChannels.ownerId, w3dsPlatformUsers.id));

  let repaired = 0;
  for (const row of rows) {
    const identity = {
      id: row.owner.id,
      eName: row.owner.eName,
      eVaultId: row.owner.eVaultId,
    };
    const next = repairedChannelName({
      storedName: row.channel.name,
      ownerDisplayName: row.owner.displayName,
      identity,
    });
    if (!next.shouldPersist) continue;
    await db
      .update(creatorChannels)
      .set({ name: next.name, updatedAt: new Date() })
      .where(eq(creatorChannels.id, row.channel.id));
    repaired += 1;
  }
  return repaired;
}
