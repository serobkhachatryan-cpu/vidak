import type { ChannelImportProvider, ImportedChannel } from '@w3ds/types';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import {
  channelImportConnections,
  channelImportOAuthStates,
  importedChannels,
  type ChannelImportStatus,
} from './db/schema';

export interface CreateChannelImportOAuthStateInput {
  id: string;
  ownerId: string;
  provider: ChannelImportProvider;
  stateHash: string;
  expiresAt: Date;
  now: Date;
}

export interface UpsertChannelImportConnectionInput {
  id: string;
  ownerId: string;
  provider: ChannelImportProvider;
  providerAccountId: string;
  accountLabel: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  grantedScopes: readonly string[];
  accessTokenExpiresAt?: Date;
  now: Date;
}

export interface UpsertImportedChannelInput {
  id: string;
  connectionId: string;
  sourceChannelId: string;
  title: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  status: ChannelImportStatus;
  now: Date;
}

export interface ChannelImportStore {
  createOAuthState(input: CreateChannelImportOAuthStateInput): Promise<void>;
  /** Atomically marks an unexpired state used; returns its owner only once. */
  consumeOAuthState(input: {
    provider: ChannelImportProvider;
    stateHash: string;
    now: Date;
  }): Promise<{ ownerId: string } | undefined>;
  upsertConnection(input: UpsertChannelImportConnectionInput): Promise<{ id: string }>;
  upsertImportedChannels(input: readonly UpsertImportedChannelInput[]): Promise<void>;
  listImportedChannelsByOwnerId(ownerId: string): Promise<ImportedChannel[]>;
}

function importedChannelFromRow(row: {
  id: string;
  provider: ChannelImportProvider;
  sourceChannelId: string;
  title: string;
  sourceUrl: string;
  thumbnailUrl: string | null;
  status: ChannelImportStatus;
  importedVideoCount: number;
  lastSyncedAt: Date | null;
}): ImportedChannel {
  return {
    id: row.id,
    provider: row.provider,
    sourceChannelId: row.sourceChannelId,
    title: row.title,
    sourceUrl: row.sourceUrl,
    ...(row.thumbnailUrl ? { thumbnailUrl: row.thumbnailUrl } : {}),
    status: row.status,
    importedVideoCount: row.importedVideoCount,
    ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt.toISOString() } : {}),
  };
}

/** In-memory implementation for provider/service tests only. */
export class InMemoryChannelImportStore implements ChannelImportStore {
  private readonly states = new Map<string, CreateChannelImportOAuthStateInput & { consumedAt?: Date }>();
  private readonly connections = new Map<
    string,
    UpsertChannelImportConnectionInput & { id: string; revokedAt?: Date }
  >();
  private readonly imports = new Map<
    string,
    UpsertImportedChannelInput & { importedVideoCount: number; lastSyncedAt?: Date }
  >();

  async createOAuthState(input: CreateChannelImportOAuthStateInput): Promise<void> {
    this.states.set(input.stateHash, { ...input });
  }

  async consumeOAuthState(input: {
    provider: ChannelImportProvider;
    stateHash: string;
    now: Date;
  }): Promise<{ ownerId: string } | undefined> {
    const state = this.states.get(input.stateHash);
    if (!state || state.provider !== input.provider || state.consumedAt || state.expiresAt <= input.now) {
      return undefined;
    }
    state.consumedAt = input.now;
    return { ownerId: state.ownerId };
  }

  async upsertConnection(input: UpsertChannelImportConnectionInput): Promise<{ id: string }> {
    const key = [input.ownerId, input.provider, input.providerAccountId].join(':');
    const existing = this.connections.get(key);
    const connection = { ...input, id: existing?.id ?? input.id };
    this.connections.set(key, connection);
    return { id: connection.id };
  }

  async upsertImportedChannels(input: readonly UpsertImportedChannelInput[]): Promise<void> {
    for (const item of input) {
      const key = [item.connectionId, item.sourceChannelId].join(':');
      const existing = this.imports.get(key);
      this.imports.set(key, {
        ...item,
        id: existing?.id ?? item.id,
        importedVideoCount: existing?.importedVideoCount ?? 0,
        ...(existing?.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
      });
    }
  }

  async listImportedChannelsByOwnerId(ownerId: string): Promise<ImportedChannel[]> {
    const ownerConnectionIds = new Set(
      [...this.connections.values()]
        .filter((connection) => connection.ownerId === ownerId && !connection.revokedAt)
        .map((connection) => connection.id),
    );
    const providersByConnectionId = new Map(
      [...this.connections.values()].map((connection) => [connection.id, connection.provider]),
    );
    return [...this.imports.values()]
      .filter((channel) => ownerConnectionIds.has(channel.connectionId))
      .sort((left, right) => right.now.getTime() - left.now.getTime())
      .map((channel) => ({
        id: channel.id,
        provider: providersByConnectionId.get(channel.connectionId)!,
        sourceChannelId: channel.sourceChannelId,
        title: channel.title,
        sourceUrl: channel.sourceUrl,
        ...(channel.thumbnailUrl ? { thumbnailUrl: channel.thumbnailUrl } : {}),
        status: channel.status,
        importedVideoCount: channel.importedVideoCount,
        ...(channel.lastSyncedAt ? { lastSyncedAt: channel.lastSyncedAt.toISOString() } : {}),
      }));
  }
}

/** PostgreSQL implementation used by Vidak production. */
export class PostgresChannelImportStore implements ChannelImportStore {
  constructor(private readonly db: W3dsDatabase) {}

  async createOAuthState(input: CreateChannelImportOAuthStateInput): Promise<void> {
    await this.db.insert(channelImportOAuthStates).values({
      id: input.id,
      ownerId: input.ownerId,
      provider: input.provider,
      stateHash: input.stateHash,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async consumeOAuthState(input: {
    provider: ChannelImportProvider;
    stateHash: string;
    now: Date;
  }): Promise<{ ownerId: string } | undefined> {
    const [claimed] = await this.db
      .update(channelImportOAuthStates)
      .set({ consumedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(channelImportOAuthStates.provider, input.provider),
          eq(channelImportOAuthStates.stateHash, input.stateHash),
          isNull(channelImportOAuthStates.consumedAt),
          gt(channelImportOAuthStates.expiresAt, input.now),
        ),
      )
      .returning({ ownerId: channelImportOAuthStates.ownerId });
    return claimed;
  }

  async upsertConnection(input: UpsertChannelImportConnectionInput): Promise<{ id: string }> {
    const [connection] = await this.db
      .insert(channelImportConnections)
      .values({
        id: input.id,
        ownerId: input.ownerId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        accountLabel: input.accountLabel,
        encryptedAccessToken: input.encryptedAccessToken,
        ...(input.encryptedRefreshToken ? { encryptedRefreshToken: input.encryptedRefreshToken } : {}),
        grantedScopes: [...input.grantedScopes],
        ...(input.accessTokenExpiresAt ? { accessTokenExpiresAt: input.accessTokenExpiresAt } : {}),
        revokedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [
          channelImportConnections.ownerId,
          channelImportConnections.provider,
          channelImportConnections.providerAccountId,
        ],
        set: {
          accountLabel: input.accountLabel,
          encryptedAccessToken: input.encryptedAccessToken,
          ...(input.encryptedRefreshToken
            ? { encryptedRefreshToken: input.encryptedRefreshToken }
            : {}),
          grantedScopes: [...input.grantedScopes],
          ...(input.accessTokenExpiresAt ? { accessTokenExpiresAt: input.accessTokenExpiresAt } : {}),
          revokedAt: null,
          updatedAt: input.now,
        },
      })
      .returning({ id: channelImportConnections.id });
    if (!connection) throw new Error('Unable to persist channel-import connection.');
    return connection;
  }

  async upsertImportedChannels(input: readonly UpsertImportedChannelInput[]): Promise<void> {
    for (const item of input) {
      await this.db
        .insert(importedChannels)
        .values({
          id: item.id,
          connectionId: item.connectionId,
          sourceChannelId: item.sourceChannelId,
          title: item.title,
          sourceUrl: item.sourceUrl,
          ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
          status: item.status,
          createdAt: item.now,
          updatedAt: item.now,
        })
        .onConflictDoUpdate({
          target: [importedChannels.connectionId, importedChannels.sourceChannelId],
          set: {
            title: item.title,
            sourceUrl: item.sourceUrl,
            ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
            status: item.status,
            failureReason: null,
            updatedAt: item.now,
          },
        });
    }
  }

  async listImportedChannelsByOwnerId(ownerId: string): Promise<ImportedChannel[]> {
    const rows = await this.db
      .select({
        id: importedChannels.id,
        provider: channelImportConnections.provider,
        sourceChannelId: importedChannels.sourceChannelId,
        title: importedChannels.title,
        sourceUrl: importedChannels.sourceUrl,
        thumbnailUrl: importedChannels.thumbnailUrl,
        status: importedChannels.status,
        importedVideoCount: importedChannels.importedVideoCount,
        lastSyncedAt: importedChannels.lastSyncedAt,
      })
      .from(importedChannels)
      .innerJoin(
        channelImportConnections,
        eq(importedChannels.connectionId, channelImportConnections.id),
      )
      .where(
        and(eq(channelImportConnections.ownerId, ownerId), isNull(channelImportConnections.revokedAt)),
      )
      .orderBy(desc(importedChannels.updatedAt));
    return rows.map(importedChannelFromRow);
  }
}
