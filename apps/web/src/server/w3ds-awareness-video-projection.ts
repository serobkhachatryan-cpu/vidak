/// <reference path="./server-only-module.d.ts" />
/**
 * Transactional inbound Video metadata projection for authenticated Awareness
 * packets. This deliberately admits only the local draft/private subset:
 * Vidak's public video lifecycle requires a ready local media asset and a
 * verified signing approval, neither of which an Awareness packet supplies.
 *
 * File references are intentionally discarded. P3 owns `w3ds://file`
 * dereferencing and upload; this module never constructs an eVault client,
 * reads a file, or copies a remote URL into a browser-facing product field.
 */

import { randomUUID } from 'node:crypto';
import type { VideoCategory, VideoLanguage } from '@w3ds/types';
import { videoCategories, videoLanguages } from '@w3ds/types';
import 'server-only';
import { eq, ne } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import {
  creatorChannels,
  videos,
  w3dsAdapterMappings,
  w3dsAwarenessReceipts,
  w3dsPlatformUsers,
} from './db/schema';
import type { W3dsAdapterMappingRecord } from './w3ds-adapter-mapping';
import type { W3dsAwarenessEnvelope } from './w3ds-awareness-admission';
import type { W3dsMappingRulesDocument } from './w3ds-mapping-rules';
import { fromGlobal, W3dsOfficialMapperError } from './w3ds-official-mapper';

export interface W3dsAwarenessVideoProjectionInput {
  envelope: W3dsAwarenessEnvelope;
  mapping: W3dsMappingRulesDocument;
  mappingVersion: number;
  /** SHA-256 of the already-verified raw AaaS delivery body. */
  payloadHash: string;
  now: number;
}

export interface W3dsAwarenessVideoProjectionResult {
  outcome: 'applied' | 'duplicate' | 'ignored';
  receiptId: string;
  localId?: string;
}

/** Explicit seam so unit tests never construct a Postgres fallback. */
export interface W3dsAwarenessVideoProjection {
  project(input: W3dsAwarenessVideoProjectionInput): Promise<W3dsAwarenessVideoProjectionResult>;
}

interface NormalizedVideoProjection {
  ownerEName: string;
  channelId: string;
  title: string;
  description: string;
  durationSeconds: number;
  category?: VideoCategory | undefined;
  language?: VideoLanguage | undefined;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryVideo {
  id: string;
  ownerId: string;
  channelId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  durationSeconds: number;
  status: 'draft';
  visibility: 'private';
  category?: VideoCategory | undefined;
  language?: VideoLanguage | undefined;
  tags: string[];
  publicVideoId: null;
  publishedAt: null;
  createdAt: Date;
  updatedAt: Date;
}

/** Explicit in-memory test double; production never falls back to it. */
export class InMemoryW3dsAwarenessVideoProjection implements W3dsAwarenessVideoProjection {
  private readonly usersByEName = new Map<string, { id: string }>();
  private readonly receiptsByGlobalId = new Map<string, { id: string; payloadHash: string }>();
  private readonly mappingsByGlobalId = new Map<string, W3dsAdapterMappingRecord>();
  private readonly channelsById = new Map<string, { id: string; ownerId: string }>();
  private readonly videosById = new Map<string, MemoryVideo>();

  seedOwner(input: { id: string; eName: string }): void {
    this.usersByEName.set(input.eName, { id: input.id });
  }

  seedChannel(input: { id: string; globalId: string; ownerId: string; ownerEName: string }): void {
    this.channelsById.set(input.id, { id: input.id, ownerId: input.ownerId });
    this.mappingsByGlobalId.set(
      input.globalId,
      memoryMapping({
        entityType: 'channel',
        entityTable: 'creator_channels',
        localId: input.id,
        globalId: input.globalId,
        ownerEName: input.ownerEName,
        schemaId: 'schema-channel-configured',
        mappingVersion: 1,
      }),
    );
  }

  getReceipt(globalId: string): { id: string } | undefined {
    const receipt = this.receiptsByGlobalId.get(globalId);
    return receipt ? { ...receipt } : undefined;
  }

  getVideoByGlobalId(globalId: string): MemoryVideo | undefined {
    const mapping = this.mappingsByGlobalId.get(globalId);
    const video = mapping ? this.videosById.get(mapping.localId) : undefined;
    return video ? { ...video, tags: [...video.tags] } : undefined;
  }

  async project(
    input: W3dsAwarenessVideoProjectionInput,
  ): Promise<W3dsAwarenessVideoProjectionResult> {
    const existingReceipt = this.receiptsByGlobalId.get(input.envelope.id);
    if (existingReceipt?.payloadHash === input.payloadHash) {
      return { outcome: 'duplicate', receiptId: existingReceipt.id };
    }

    const receiptId = existingReceipt?.id ?? randomUUID();
    if (mustIgnoreVideoLifecycle(input.envelope.data)) {
      this.receiptsByGlobalId.set(input.envelope.id, {
        id: receiptId,
        payloadHash: input.payloadHash,
      });
      return { outcome: 'ignored', receiptId };
    }

    const prepared = await prepareVideoProjection(input, {
      getByGlobalId: async (globalId) => this.mappingsByGlobalId.get(globalId),
    });
    const owner = this.usersByEName.get(prepared.ownerEName);
    if (!owner)
      throw new W3dsAwarenessVideoProjectionError('Packet owner is not a local platform user.');

    const relatedChannel = this.channelsById.get(prepared.channelId);
    const relatedMapping = this.mappingsByGlobalId.get(
      requiredChannelGlobalId(input.envelope.data),
    );
    if (
      !relatedChannel ||
      relatedChannel.ownerId !== owner.id ||
      !relatedMapping ||
      relatedMapping.entityType !== 'channel' ||
      relatedMapping.entityTable !== 'creator_channels' ||
      relatedMapping.localId !== prepared.channelId ||
      relatedMapping.ownerEName !== prepared.ownerEName
    ) {
      throw new W3dsAwarenessVideoProjectionError(
        'Video Channel relation is not a local owner mapping.',
      );
    }

    const existingMapping = this.mappingsByGlobalId.get(input.envelope.id);
    let localId: string;
    if (existingMapping) {
      assertVideoMappingCompatibility(existingMapping, input, prepared.ownerEName);
      const existingVideo = this.videosById.get(existingMapping.localId);
      if (
        !existingVideo ||
        existingVideo.ownerId !== owner.id ||
        existingVideo.channelId !== prepared.channelId
      ) {
        throw new W3dsAwarenessVideoProjectionError(
          'Mapped Video ownership conflicts with the packet.',
        );
      }
      if (existingVideo.status !== 'draft' || existingVideo.visibility !== 'private') {
        this.receiptsByGlobalId.set(input.envelope.id, {
          id: receiptId,
          payloadHash: input.payloadHash,
        });
        return { outcome: 'ignored', receiptId };
      }
      this.videosById.set(existingVideo.id, applyVideoUpdate(existingVideo, prepared));
      localId = existingVideo.id;
    } else {
      localId = randomUUID();
      this.videosById.set(localId, newMemoryVideo(localId, owner.id, prepared));
      this.mappingsByGlobalId.set(
        input.envelope.id,
        memoryMapping({
          entityType: 'video',
          entityTable: 'videos',
          localId,
          globalId: input.envelope.id,
          ownerEName: prepared.ownerEName,
          schemaId: input.mapping.schemaId,
          mappingVersion: input.mappingVersion,
        }),
      );
    }

    this.receiptsByGlobalId.set(input.envelope.id, {
      id: receiptId,
      payloadHash: input.payloadHash,
    });
    return { outcome: 'applied', receiptId, localId };
  }
}

export class PostgresW3dsAwarenessVideoProjection implements W3dsAwarenessVideoProjection {
  constructor(private readonly db: W3dsDatabase) {}

  async project(
    input: W3dsAwarenessVideoProjectionInput,
  ): Promise<W3dsAwarenessVideoProjectionResult> {
    return this.db.transaction(async (tx) => {
      const [changedReceipt] = await tx
        .insert(w3dsAwarenessReceipts)
        .values({
          id: randomUUID(),
          globalId: input.envelope.id,
          payloadHash: input.payloadHash,
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        })
        .onConflictDoUpdate({
          target: w3dsAwarenessReceipts.globalId,
          set: { payloadHash: input.payloadHash, updatedAt: new Date(input.now) },
          setWhere: ne(w3dsAwarenessReceipts.payloadHash, input.payloadHash),
        })
        .returning();
      if (!changedReceipt) {
        const [existingReceipt] = await tx
          .select()
          .from(w3dsAwarenessReceipts)
          .where(eq(w3dsAwarenessReceipts.globalId, input.envelope.id))
          .limit(1);
        if (!existingReceipt) {
          throw new W3dsAwarenessVideoProjectionError(
            'Unable to read concurrent Awareness receipt.',
          );
        }
        return { outcome: 'duplicate', receiptId: existingReceipt.id };
      }

      // A webhook never gets to publish a Vidak video or make it externally
      // visible. Record the authenticated delivery, but retain no product data.
      if (mustIgnoreVideoLifecycle(input.envelope.data)) {
        return { outcome: 'ignored', receiptId: changedReceipt.id };
      }

      const prepared = await prepareVideoProjection(input, {
        getByGlobalId: async (globalId) => {
          const [mapping] = await tx
            .select()
            .from(w3dsAdapterMappings)
            .where(eq(w3dsAdapterMappings.globalId, globalId))
            .limit(1);
          return mapping ? mappingRecordFromRow(mapping) : undefined;
        },
      });
      const [owner] = await tx
        .select({ id: w3dsPlatformUsers.id })
        .from(w3dsPlatformUsers)
        .where(eq(w3dsPlatformUsers.eName, prepared.ownerEName))
        .limit(1);
      if (!owner)
        throw new W3dsAwarenessVideoProjectionError('Packet owner is not a local platform user.');

      const [relatedChannelMapping] = await tx
        .select()
        .from(w3dsAdapterMappings)
        .where(eq(w3dsAdapterMappings.globalId, requiredChannelGlobalId(input.envelope.data)))
        .limit(1);
      const [relatedChannel] = await tx
        .select({ id: creatorChannels.id, ownerId: creatorChannels.ownerId })
        .from(creatorChannels)
        .where(eq(creatorChannels.id, prepared.channelId))
        .limit(1);
      if (
        !relatedChannel ||
        relatedChannel.ownerId !== owner.id ||
        !relatedChannelMapping ||
        relatedChannelMapping.entityType !== 'channel' ||
        relatedChannelMapping.entityTable !== 'creator_channels' ||
        relatedChannelMapping.localId !== prepared.channelId ||
        relatedChannelMapping.ownerEName !== prepared.ownerEName
      ) {
        throw new W3dsAwarenessVideoProjectionError(
          'Video Channel relation is not a local owner mapping.',
        );
      }

      const [existingMapping] = await tx
        .select()
        .from(w3dsAdapterMappings)
        .where(eq(w3dsAdapterMappings.globalId, input.envelope.id))
        .limit(1);
      if (existingMapping) {
        assertVideoMappingCompatibility(existingMapping, input, prepared.ownerEName);
        const [existingVideo] = await tx
          .select()
          .from(videos)
          .where(eq(videos.id, existingMapping.localId))
          .limit(1);
        if (
          !existingVideo ||
          existingVideo.ownerId !== owner.id ||
          existingVideo.channelId !== prepared.channelId
        ) {
          throw new W3dsAwarenessVideoProjectionError(
            'Mapped Video ownership conflicts with the packet.',
          );
        }
        if (existingVideo.status !== 'draft' || existingVideo.visibility !== 'private') {
          return { outcome: 'ignored', receiptId: changedReceipt.id };
        }
        const [updated] = await tx
          .update(videos)
          .set(videoUpdateValues(prepared))
          .where(eq(videos.id, existingVideo.id))
          .returning({ id: videos.id });
        if (!updated) throw new W3dsAwarenessVideoProjectionError('Failed to update mapped Video.');
        return { outcome: 'applied', receiptId: changedReceipt.id, localId: updated.id };
      }

      const localId = randomUUID();
      const [createdVideo] = await tx
        .insert(videos)
        .values(videoInsertValues(localId, owner.id, prepared))
        .returning({ id: videos.id });
      if (!createdVideo) throw new W3dsAwarenessVideoProjectionError('Failed to create Video.');

      const [createdMapping] = await tx
        .insert(w3dsAdapterMappings)
        .values({
          id: randomUUID(),
          entityType: 'video',
          entityTable: 'videos',
          localId,
          globalId: input.envelope.id,
          ownerEName: prepared.ownerEName,
          schemaId: input.mapping.schemaId,
          mappingVersion: input.mappingVersion,
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        })
        .returning({ id: w3dsAdapterMappings.id });
      if (!createdMapping)
        throw new W3dsAwarenessVideoProjectionError('Failed to create Video mapping.');
      return { outcome: 'applied', receiptId: changedReceipt.id, localId };
    });
  }
}

export function createPostgresW3dsAwarenessVideoProjection(
  db: W3dsDatabase,
): PostgresW3dsAwarenessVideoProjection {
  return new PostgresW3dsAwarenessVideoProjection(db);
}

export class W3dsAwarenessVideoProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W3dsAwarenessVideoProjectionError';
  }
}

async function prepareVideoProjection(
  input: W3dsAwarenessVideoProjectionInput,
  mappingService: Pick<import('./w3ds-adapter-mapping').W3dsAdapterMappingService, 'getByGlobalId'>,
): Promise<NormalizedVideoProjection> {
  if (input.mapping.entityType !== 'video' || input.mapping.tableName !== 'videos') {
    throw new W3dsAwarenessVideoProjectionError(
      'Only the configured Video mapping is projectable.',
    );
  }

  let local: Record<string, unknown>;
  try {
    local = await fromGlobal({ data: input.envelope.data, mapping: input.mapping, mappingService });
  } catch (error) {
    if (
      error instanceof W3dsOfficialMapperError ||
      error instanceof W3dsAwarenessVideoProjectionError
    ) {
      throw error;
    }
    throw new W3dsAwarenessVideoProjectionError('Video payload could not be mapped.');
  }

  const ownerEName = requiredEName(local.ownerEName, 'ownerEName');
  if (ownerEName !== input.envelope.w3id) {
    throw new W3dsAwarenessVideoProjectionError(
      'Video ownerEName does not match the authenticated packet owner.',
    );
  }

  const category = optionalCategory(local.category);
  const language = optionalLanguage(local.language);
  return {
    ownerEName,
    channelId: requiredString(local.channelId, 'channelId'),
    title: requiredString(local.title, 'title', 100),
    description: optionalString(local.description, 'description', 5000) ?? '',
    durationSeconds: optionalCount(local.durationSeconds, 'durationSeconds') ?? 0,
    ...(category ? { category } : {}),
    ...(language ? { language } : {}),
    tags: optionalTags(local.tags),
    createdAt: requiredDate(local.createdAt, 'createdAt'),
    updatedAt: requiredDate(local.updatedAt, 'updatedAt'),
  };
}

function mustIgnoreVideoLifecycle(data: Record<string, unknown>): boolean {
  return (
    data.status !== 'draft' ||
    data.visibility !== 'private' ||
    hasMeaningfulValue(data.publicVideoId) ||
    hasMeaningfulValue(data.publishedAt)
  );
}

function hasMeaningfulValue(value: unknown): boolean {
  return (
    value !== undefined && value !== null && (typeof value !== 'string' || Boolean(value.trim()))
  );
}

function requiredChannelGlobalId(data: Record<string, unknown>): string {
  return requiredString(data.channelId, 'channelId');
}

function assertVideoMappingCompatibility(
  mapping: {
    entityType: string;
    entityTable: string;
    globalId: string;
    ownerEName: string;
    schemaId: string;
    mappingVersion: number;
  },
  input: W3dsAwarenessVideoProjectionInput,
  ownerEName: string,
): void {
  if (
    mapping.entityType !== 'video' ||
    mapping.entityTable !== 'videos' ||
    mapping.globalId !== input.envelope.id ||
    mapping.ownerEName !== ownerEName ||
    mapping.schemaId !== input.mapping.schemaId ||
    mapping.mappingVersion !== input.mappingVersion
  ) {
    throw new W3dsAwarenessVideoProjectionError(
      'Existing Video mapping conflicts with the incoming packet.',
    );
  }
}

function newMemoryVideo(
  localId: string,
  ownerId: string,
  prepared: NormalizedVideoProjection,
): MemoryVideo {
  return {
    id: localId,
    ownerId,
    channelId: prepared.channelId,
    title: prepared.title,
    description: prepared.description,
    thumbnailUrl: '',
    durationSeconds: prepared.durationSeconds,
    status: 'draft',
    visibility: 'private',
    ...(prepared.category ? { category: prepared.category } : {}),
    ...(prepared.language ? { language: prepared.language } : {}),
    tags: [...prepared.tags],
    publicVideoId: null,
    publishedAt: null,
    createdAt: prepared.createdAt,
    updatedAt: prepared.updatedAt,
  };
}

function applyVideoUpdate(existing: MemoryVideo, prepared: NormalizedVideoProjection): MemoryVideo {
  return {
    ...existing,
    title: prepared.title,
    description: prepared.description,
    durationSeconds: prepared.durationSeconds,
    ...(prepared.category ? { category: prepared.category } : { category: undefined }),
    ...(prepared.language ? { language: prepared.language } : { language: undefined }),
    tags: [...prepared.tags],
    updatedAt: prepared.updatedAt,
  };
}

function videoInsertValues(localId: string, ownerId: string, prepared: NormalizedVideoProjection) {
  return {
    id: localId,
    ownerId,
    channelId: prepared.channelId,
    title: prepared.title,
    description: prepared.description,
    thumbnailUrl: '',
    durationSeconds: prepared.durationSeconds,
    status: 'draft' as const,
    visibility: 'private' as const,
    ...(prepared.category ? { category: prepared.category } : {}),
    ...(prepared.language ? { language: prepared.language } : {}),
    tags: prepared.tags,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    publicVideoId: null,
    publishedAt: null,
    createdAt: prepared.createdAt,
    updatedAt: prepared.updatedAt,
  };
}

function videoUpdateValues(prepared: NormalizedVideoProjection) {
  return {
    title: prepared.title,
    description: prepared.description,
    // Media references remain P3, including thumbnailFileUri. Keep Vidak's
    // local product field empty instead of surfacing remote `w3ds://file` data.
    thumbnailUrl: '',
    durationSeconds: prepared.durationSeconds,
    ...(prepared.category ? { category: prepared.category } : { category: null }),
    ...(prepared.language ? { language: prepared.language } : { language: null }),
    tags: prepared.tags,
    updatedAt: prepared.updatedAt,
  };
}

function memoryMapping(input: {
  entityType: W3dsAdapterMappingRecord['entityType'];
  entityTable: string;
  localId: string;
  globalId: string;
  ownerEName: string;
  schemaId: string;
  mappingVersion: number;
}): W3dsAdapterMappingRecord {
  const timestamp = new Date(0).toISOString();
  return { id: randomUUID(), ...input, createdAt: timestamp, updatedAt: timestamp };
}

function mappingRecordFromRow(row: {
  id: string;
  entityType: W3dsAdapterMappingRecord['entityType'];
  entityTable: string;
  localId: string;
  globalId: string;
  ownerEName: string;
  schemaId: string;
  mappingVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): W3dsAdapterMappingRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requiredString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new W3dsAwarenessVideoProjectionError(`Video ${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (maxLength && normalized.length > maxLength) {
    throw new W3dsAwarenessVideoProjectionError(`Video ${field} exceeds the local product limit.`);
  }
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength?: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field, maxLength);
}

function requiredEName(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (!/^@[^\s@]+$/.test(normalized)) {
    throw new W3dsAwarenessVideoProjectionError(`Video ${field} must be an eName.`);
  }
  return normalized;
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new W3dsAwarenessVideoProjectionError(`Video ${field} must be a non-negative integer.`);
  }
  return value;
}

function optionalCategory(value: unknown): VideoCategory | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(videoCategories as readonly string[]).includes(value)) {
    throw new W3dsAwarenessVideoProjectionError('Video category is not supported by Vidak.');
  }
  return value as VideoCategory;
}

function optionalLanguage(value: unknown): VideoLanguage | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(videoLanguages as readonly string[]).includes(value)) {
    throw new W3dsAwarenessVideoProjectionError('Video language is not supported by Vidak.');
  }
  return value as VideoLanguage;
}

function optionalTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((tag) => typeof tag !== 'string')) {
    throw new W3dsAwarenessVideoProjectionError('Video tags must be at most 20 strings.');
  }
  return value.map((tag) => tag.trim()).filter(Boolean);
}

function requiredDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new W3dsAwarenessVideoProjectionError(`Video ${field} must be an ISO date string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new W3dsAwarenessVideoProjectionError(`Video ${field} must be an ISO date string.`);
  }
  return parsed;
}
