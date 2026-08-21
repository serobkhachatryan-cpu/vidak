import type {
  Channel,
  UpdateVideoDraftInput,
  Video,
  VideoCategory,
  VideoLanguage,
  VideoVisibility,
} from '@w3ds/types';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { CreatorVideoError } from './creator-video-errors';
import type { W3dsDatabase } from './db/client';
import { creatorChannels, mediaAssets, videos } from './db/schema';

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
  createDraft(input: CreateDraftRecordInput): Promise<Video>;
  listDraftsByOwnerId(ownerId: string): Promise<Video[]>;
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

function toVideo(row: {
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
}): Video {
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
  };
}

function cloneChannel(channel: Channel): Channel {
  return { ...channel };
}

function cloneVideo(video: Video): Video {
  return { ...video, tags: [...video.tags] };
}

type StoredVideo = Video & { ownerId: string };

/** In-memory store for unit tests only — never used as a production fallback. */
export class InMemoryCreatorVideoStore implements CreatorVideoStore {
  private readonly channelsByOwnerId = new Map<string, Channel>();
  private readonly channelsById = new Map<string, Channel>();
  private readonly videosById = new Map<string, StoredVideo>();
  /** videoId → ready media asset count (test helper for publish preconditions). */
  private readonly readyMediaCounts = new Map<string, number>();

  /** Test helper: registers that an owned video has a ready media asset attached. */
  seedReadyMediaAsset(videoId: string): void {
    this.readyMediaCounts.set(videoId, (this.readyMediaCounts.get(videoId) ?? 0) + 1);
  }

  /** Test helper: clears ready-media registration for a video. */
  clearReadyMediaAssets(videoId: string): void {
    this.readyMediaCounts.delete(videoId);
  }

  async findOrCreateChannel(input: CreateChannelRecordInput): Promise<Channel> {
    const existing = this.channelsByOwnerId.get(input.ownerId);
    if (existing) return cloneChannel(existing);
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
    return match ? cloneVideo(match) : undefined;
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
      .map(cloneVideo);
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
    return existing;
  }

  async findChannelByOwnerId(ownerId: string): Promise<Channel | undefined> {
    const [row] = await this.db
      .select()
      .from(creatorChannels)
      .where(eq(creatorChannels.ownerId, ownerId))
      .limit(1);
    return row ? toChannel(row) : undefined;
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
    return rows.map(toVideo);
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
      .select()
      .from(videos)
      .where(
        and(
          eq(videos.publicVideoId, normalized),
          eq(videos.status, 'published'),
          inArray(videos.visibility, ['public', 'unlisted']),
        ),
      )
      .limit(1);
    return row ? toVideo(row) : undefined;
  }

  async listPublishedPublicVideos(limit: number, offset: number): Promise<Video[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    const safeOffset = Math.max(0, Math.floor(offset));
    if (safeLimit === 0) return [];
    const rows = await this.db
      .select()
      .from(videos)
      .where(and(eq(videos.status, 'published'), eq(videos.visibility, 'public')))
      .orderBy(desc(videos.publishedAt), desc(videos.id))
      .limit(safeLimit)
      .offset(safeOffset);
    return rows.map(toVideo);
  }
}
