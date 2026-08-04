import type {
  Channel,
  UpdateVideoDraftInput,
  Video,
  VideoCategory,
  VideoLanguage,
  VideoVisibility,
} from '@w3ds/types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { CreatorVideoError } from './creator-video-errors';
import type { W3dsDatabase } from './db/client';
import { creatorChannels, videos } from './db/schema';

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
 * Durable persistence for local creator channels and video drafts.
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
  updateDraft(
    videoId: string,
    ownerId: string,
    input: UpdateVideoDraftInput,
  ): Promise<Video | undefined>;
  deleteDraft(videoId: string, ownerId: string): Promise<boolean>;
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

/** In-memory store for unit tests only — never used as a production fallback. */
export class InMemoryCreatorVideoStore implements CreatorVideoStore {
  private readonly channelsByOwnerId = new Map<string, Channel>();
  private readonly channelsById = new Map<string, Channel>();
  private readonly draftsById = new Map<string, Video & { ownerId: string }>();

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
    const video: Video & { ownerId: string } = {
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
    this.draftsById.set(video.id, video);
    const nextChannel: Channel = { ...channel, videoCount: channel.videoCount + 1 };
    this.channelsById.set(nextChannel.id, nextChannel);
    this.channelsByOwnerId.set(nextChannel.ownerId, nextChannel);
    return cloneVideo(video);
  }

  async listDraftsByOwnerId(ownerId: string): Promise<Video[]> {
    return [...this.draftsById.values()]
      .filter((draft) => draft.ownerId === ownerId && draft.status === 'draft')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneVideo);
  }

  async getOwnedDraft(videoId: string, ownerId: string): Promise<Video | undefined> {
    const draft = this.draftsById.get(videoId);
    if (!draft || draft.ownerId !== ownerId || draft.status !== 'draft') return undefined;
    return cloneVideo(draft);
  }

  async updateDraft(
    videoId: string,
    ownerId: string,
    input: UpdateVideoDraftInput,
  ): Promise<Video | undefined> {
    const existing = this.draftsById.get(videoId);
    if (!existing || existing.ownerId !== ownerId || existing.status !== 'draft') {
      return undefined;
    }
    const next: Video & { ownerId: string } = {
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
    this.draftsById.set(videoId, next);
    return cloneVideo(next);
  }

  async deleteDraft(videoId: string, ownerId: string): Promise<boolean> {
    const existing = this.draftsById.get(videoId);
    if (!existing || existing.ownerId !== ownerId || existing.status !== 'draft') {
      return false;
    }
    this.draftsById.delete(videoId);
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
}
