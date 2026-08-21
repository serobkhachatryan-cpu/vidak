/// <reference path="./server-only-module.d.ts" />
/**
 * Transactional inbound Channel projection for authenticated Awareness packets.
 *
 * This is deliberately limited to the one product entity with a durable local
 * table and a verified local owner relationship. It maps only a configured
 * official Channel schema, creates a receipt and local/global mapping in the
 * same transaction, and never reaches Registry, eVault, files, or outbound
 * sync. Media-bearing fields remain P3: existing HTTPS URLs may be retained,
 * while `w3ds://file` values are not dereferenced or copied into product URLs.
 */

import { randomUUID } from 'node:crypto';
import 'server-only';
import { eq, ne } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import {
  creatorChannels,
  w3dsAdapterMappings,
  w3dsAwarenessReceipts,
  w3dsPlatformUsers,
} from './db/schema';
import type { W3dsAwarenessEnvelope } from './w3ds-awareness-admission';
import type { W3dsMappingRulesDocument } from './w3ds-mapping-rules';
import { optionalW3dsFileUri } from './w3ds-official-file-client';
import { fromGlobal, W3dsOfficialMapperError } from './w3ds-official-mapper';

export interface W3dsAwarenessChannelProjectionInput {
  envelope: W3dsAwarenessEnvelope;
  mapping: W3dsMappingRulesDocument;
  mappingVersion: number;
  /** SHA-256 of the already-verified raw AaaS delivery body. */
  payloadHash: string;
  now: number;
}

export interface W3dsAwarenessChannelProjectionResult {
  outcome: 'applied' | 'duplicate';
  receiptId: string;
  localId?: string;
}

/** The handler accepts this seam so unit tests never need a Postgres fallback. */
export interface W3dsAwarenessChannelProjection {
  project(
    input: W3dsAwarenessChannelProjectionInput,
  ): Promise<W3dsAwarenessChannelProjectionResult>;
}

interface NormalizedChannelProjection {
  ownerEName: string;
  handle: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  subscriberCount?: number;
  videoCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryChannel {
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
  updatedAt: Date;
}

interface MemoryMapping {
  entityType: 'channel';
  entityTable: 'creator_channels';
  localId: string;
  globalId: string;
  ownerEName: string;
  schemaId: string;
  mappingVersion: number;
}

/**
 * Explicit test double. Production always uses Postgres and never falls back
 * to this in-memory projector.
 */
export class InMemoryW3dsAwarenessChannelProjection implements W3dsAwarenessChannelProjection {
  private readonly usersByEName = new Map<string, { id: string }>();
  private readonly receiptsByGlobalId = new Map<string, { id: string; payloadHash: string }>();
  private readonly mappingsByGlobalId = new Map<string, MemoryMapping>();
  private readonly channelsById = new Map<string, MemoryChannel>();
  private readonly channelIdByOwnerId = new Map<string, string>();
  private readonly channelIdByHandle = new Map<string, string>();

  seedOwner(input: { id: string; eName: string }): void {
    this.usersByEName.set(input.eName, { id: input.id });
  }

  getReceipt(globalId: string): { id: string } | undefined {
    const receipt = this.receiptsByGlobalId.get(globalId);
    return receipt ? { ...receipt } : undefined;
  }

  getChannelByGlobalId(globalId: string): MemoryChannel | undefined {
    const mapping = this.mappingsByGlobalId.get(globalId);
    const channel = mapping ? this.channelsById.get(mapping.localId) : undefined;
    return channel ? { ...channel } : undefined;
  }

  async project(
    input: W3dsAwarenessChannelProjectionInput,
  ): Promise<W3dsAwarenessChannelProjectionResult> {
    const existingReceipt = this.receiptsByGlobalId.get(input.envelope.id);
    if (existingReceipt?.payloadHash === input.payloadHash) {
      return { outcome: 'duplicate', receiptId: existingReceipt.id };
    }

    const prepared = await prepareChannelProjection(input);
    const existingMapping = this.mappingsByGlobalId.get(input.envelope.id);
    let localId: string;

    if (existingMapping) {
      assertMappingCompatibility(existingMapping, input, prepared.ownerEName);
      const existingChannel = this.channelsById.get(existingMapping.localId);
      if (!existingChannel)
        throw new W3dsAwarenessChannelProjectionError('Mapped Channel is missing.');
      const owner = this.usersByEName.get(prepared.ownerEName);
      if (!owner || existingChannel.ownerId !== owner.id) {
        throw new W3dsAwarenessChannelProjectionError(
          'Mapped Channel owner does not match packet owner.',
        );
      }
      if (existingChannel.handle !== prepared.handle) {
        const byHandle = this.channelIdByHandle.get(prepared.handle);
        if (byHandle && byHandle !== existingChannel.id) {
          throw new W3dsAwarenessChannelProjectionError(
            'Incoming Channel handle belongs to another local Channel.',
          );
        }
        this.channelIdByHandle.delete(existingChannel.handle);
        this.channelIdByHandle.set(prepared.handle, existingChannel.id);
      }
      this.channelsById.set(existingChannel.id, applyChannelUpdate(existingChannel, prepared));
      localId = existingChannel.id;
    } else {
      const owner = this.usersByEName.get(prepared.ownerEName);
      if (!owner)
        throw new W3dsAwarenessChannelProjectionError('Packet owner is not a local platform user.');
      if (this.channelIdByOwnerId.has(owner.id) || this.channelIdByHandle.has(prepared.handle)) {
        throw new W3dsAwarenessChannelProjectionError(
          'Incoming Channel conflicts with an unmapped local Channel.',
        );
      }
      localId = randomUUID();
      const channel: MemoryChannel = {
        id: localId,
        ownerId: owner.id,
        handle: prepared.handle,
        name: prepared.name,
        description: prepared.description ?? null,
        avatarUrl: prepared.avatarUrl ?? null,
        bannerUrl: prepared.bannerUrl ?? null,
        subscriberCount: prepared.subscriberCount ?? 0,
        videoCount: prepared.videoCount ?? 0,
        createdAt: prepared.createdAt,
        updatedAt: prepared.updatedAt,
      };
      this.channelsById.set(localId, channel);
      this.channelIdByOwnerId.set(owner.id, localId);
      this.channelIdByHandle.set(prepared.handle, localId);
      this.mappingsByGlobalId.set(input.envelope.id, {
        entityType: 'channel',
        entityTable: 'creator_channels',
        localId,
        globalId: input.envelope.id,
        ownerEName: prepared.ownerEName,
        schemaId: input.mapping.schemaId,
        mappingVersion: input.mappingVersion,
      });
    }

    const receiptId = existingReceipt?.id ?? randomUUID();
    this.receiptsByGlobalId.set(input.envelope.id, {
      id: receiptId,
      payloadHash: input.payloadHash,
    });
    return { outcome: 'applied', receiptId, localId };
  }
}

export class PostgresW3dsAwarenessChannelProjection implements W3dsAwarenessChannelProjection {
  constructor(private readonly db: W3dsDatabase) {}

  async project(
    input: W3dsAwarenessChannelProjectionInput,
  ): Promise<W3dsAwarenessChannelProjectionResult> {
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
          throw new W3dsAwarenessChannelProjectionError(
            'Unable to read concurrent Awareness receipt.',
          );
        }
        return { outcome: 'duplicate', receiptId: existingReceipt.id };
      }

      const prepared = await prepareChannelProjection(input);
      const [owner] = await tx
        .select({ id: w3dsPlatformUsers.id })
        .from(w3dsPlatformUsers)
        .where(eq(w3dsPlatformUsers.eName, prepared.ownerEName))
        .limit(1);
      if (!owner) {
        throw new W3dsAwarenessChannelProjectionError('Packet owner is not a local platform user.');
      }

      const [existingMapping] = await tx
        .select()
        .from(w3dsAdapterMappings)
        .where(eq(w3dsAdapterMappings.globalId, input.envelope.id))
        .limit(1);

      if (existingMapping) {
        assertMappingCompatibility(existingMapping, input, prepared.ownerEName);
        const [existingChannel] = await tx
          .select()
          .from(creatorChannels)
          .where(eq(creatorChannels.id, existingMapping.localId))
          .limit(1);
        if (!existingChannel || existingChannel.ownerId !== owner.id) {
          throw new W3dsAwarenessChannelProjectionError(
            'Mapped Channel owner does not match packet owner.',
          );
        }
        const [updated] = await tx
          .update(creatorChannels)
          .set(channelUpdateValues(existingChannel, prepared))
          .where(eq(creatorChannels.id, existingChannel.id))
          .returning({ id: creatorChannels.id });
        if (!updated)
          throw new W3dsAwarenessChannelProjectionError('Failed to update mapped Channel.');
        return { outcome: 'applied', receiptId: changedReceipt.id, localId: updated.id };
      }

      const [existingOwnerChannel] = await tx
        .select({ id: creatorChannels.id })
        .from(creatorChannels)
        .where(eq(creatorChannels.ownerId, owner.id))
        .limit(1);
      const [existingHandleChannel] = await tx
        .select({ id: creatorChannels.id })
        .from(creatorChannels)
        .where(eq(creatorChannels.handle, prepared.handle))
        .limit(1);
      if (existingOwnerChannel || existingHandleChannel) {
        throw new W3dsAwarenessChannelProjectionError(
          'Incoming Channel conflicts with an unmapped local Channel.',
        );
      }

      const localId = randomUUID();
      const [createdChannel] = await tx
        .insert(creatorChannels)
        .values({
          id: localId,
          ownerId: owner.id,
          handle: prepared.handle,
          name: prepared.name,
          description: prepared.description ?? null,
          avatarUrl: prepared.avatarUrl ?? null,
          bannerUrl: prepared.bannerUrl ?? null,
          subscriberCount: prepared.subscriberCount ?? 0,
          videoCount: prepared.videoCount ?? 0,
          createdAt: prepared.createdAt,
          updatedAt: prepared.updatedAt,
        })
        .returning({ id: creatorChannels.id });
      if (!createdChannel)
        throw new W3dsAwarenessChannelProjectionError('Failed to create Channel.');

      const [createdMapping] = await tx
        .insert(w3dsAdapterMappings)
        .values({
          id: randomUUID(),
          entityType: 'channel',
          entityTable: 'creator_channels',
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
        throw new W3dsAwarenessChannelProjectionError('Failed to create Channel mapping.');

      return { outcome: 'applied', receiptId: changedReceipt.id, localId };
    });
  }
}

export function createPostgresW3dsAwarenessChannelProjection(
  db: W3dsDatabase,
): PostgresW3dsAwarenessChannelProjection {
  return new PostgresW3dsAwarenessChannelProjection(db);
}

export class W3dsAwarenessChannelProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W3dsAwarenessChannelProjectionError';
  }
}

async function prepareChannelProjection(
  input: W3dsAwarenessChannelProjectionInput,
): Promise<NormalizedChannelProjection> {
  if (input.mapping.entityType !== 'channel' || input.mapping.tableName !== 'creator_channels') {
    throw new W3dsAwarenessChannelProjectionError(
      'Only the configured Channel mapping is projectable.',
    );
  }

  let local: Record<string, unknown>;
  try {
    local = await fromGlobal({
      data: input.envelope.data,
      mapping: input.mapping,
      mappingService: {
        getByGlobalId: async () => {
          throw new W3dsAwarenessChannelProjectionError(
            'Channel mapping cannot resolve an undeclared relation.',
          );
        },
      },
    });
  } catch (error) {
    if (
      error instanceof W3dsOfficialMapperError ||
      error instanceof W3dsAwarenessChannelProjectionError
    ) {
      throw error;
    }
    throw new W3dsAwarenessChannelProjectionError('Channel payload could not be mapped.');
  }

  const ownerEName = requiredEName(local.ownerEName, 'ownerEName');
  if (ownerEName !== input.envelope.w3id) {
    throw new W3dsAwarenessChannelProjectionError(
      'Channel ownerEName does not match the authenticated packet owner.',
    );
  }

  const description = optionalString(local.description, 'description');
  const avatarUrl = optionalProductUrl(local.avatarUrl, 'avatarUrl');
  const bannerUrl = optionalProductUrl(local.bannerUrl, 'bannerUrl');
  const subscriberCount = optionalCount(local.subscriberCount, 'subscriberCount');
  const videoCount = optionalCount(local.videoCount, 'videoCount');

  return {
    ownerEName,
    handle: requiredString(local.handle, 'handle'),
    name: requiredString(local.name, 'name'),
    ...(description !== undefined ? { description } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(bannerUrl !== undefined ? { bannerUrl } : {}),
    ...(subscriberCount !== undefined ? { subscriberCount } : {}),
    ...(videoCount !== undefined ? { videoCount } : {}),
    createdAt: requiredDate(local.createdAt, 'createdAt'),
    updatedAt: requiredDate(local.updatedAt, 'updatedAt'),
  };
}

function assertMappingCompatibility(
  mapping: {
    entityType: string;
    entityTable: string;
    globalId: string;
    ownerEName: string;
    schemaId: string;
    mappingVersion: number;
  },
  input: W3dsAwarenessChannelProjectionInput,
  ownerEName: string,
): void {
  if (
    mapping.entityType !== 'channel' ||
    mapping.entityTable !== 'creator_channels' ||
    mapping.globalId !== input.envelope.id ||
    mapping.ownerEName !== ownerEName ||
    mapping.schemaId !== input.mapping.schemaId ||
    mapping.mappingVersion !== input.mappingVersion
  ) {
    throw new W3dsAwarenessChannelProjectionError(
      'Existing Channel mapping conflicts with the incoming packet.',
    );
  }
}

function applyChannelUpdate(
  existing: MemoryChannel,
  prepared: NormalizedChannelProjection,
): MemoryChannel {
  return {
    ...existing,
    handle: prepared.handle,
    name: prepared.name,
    ...(prepared.description !== undefined ? { description: prepared.description } : {}),
    ...(prepared.avatarUrl !== undefined ? { avatarUrl: prepared.avatarUrl } : {}),
    ...(prepared.bannerUrl !== undefined ? { bannerUrl: prepared.bannerUrl } : {}),
    ...(prepared.subscriberCount !== undefined
      ? { subscriberCount: prepared.subscriberCount }
      : {}),
    ...(prepared.videoCount !== undefined ? { videoCount: prepared.videoCount } : {}),
    updatedAt: prepared.updatedAt,
  };
}

function channelUpdateValues(
  existing: {
    description: string | null;
    avatarUrl: string | null;
    bannerUrl: string | null;
    subscriberCount: number;
    videoCount: number;
  },
  prepared: NormalizedChannelProjection,
) {
  return {
    handle: prepared.handle,
    name: prepared.name,
    description: prepared.description ?? existing.description,
    avatarUrl: prepared.avatarUrl ?? existing.avatarUrl,
    bannerUrl: prepared.bannerUrl ?? existing.bannerUrl,
    subscriberCount: prepared.subscriberCount ?? existing.subscriberCount,
    videoCount: prepared.videoCount ?? existing.videoCount,
    updatedAt: prepared.updatedAt,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new W3dsAwarenessChannelProjectionError(`Channel ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

function requiredEName(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (!/^@[^\s@]+$/.test(normalized)) {
    throw new W3dsAwarenessChannelProjectionError(`Channel ${field} must be an eName.`);
  }
  return normalized;
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new W3dsAwarenessChannelProjectionError(
      `Channel ${field} must be a non-negative integer.`,
    );
  }
  return value;
}

function requiredDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new W3dsAwarenessChannelProjectionError(`Channel ${field} must be an ISO date string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new W3dsAwarenessChannelProjectionError(`Channel ${field} must be an ISO date string.`);
  }
  return parsed;
}

function optionalProductUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = requiredString(value, field);
  // P3's documented eVault file resolution is unavailable. Never dereference
  // or publish a W3DS URI as a browser-facing product URL.
  if (optionalW3dsFileUri(normalized)) return undefined;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('not http');
    }
    return normalized;
  } catch {
    throw new W3dsAwarenessChannelProjectionError(`Channel ${field} must be an HTTP(S) URL.`);
  }
}
