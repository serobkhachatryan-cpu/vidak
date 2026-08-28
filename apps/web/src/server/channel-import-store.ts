import type { ChannelImportProvider, ImportedChannel } from '@w3ds/types';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import {
  type ChannelImportStatus,
  channelImportConnections,
  channelImportOAuthStates,
  channelImportSyncJobs,
  importedChannels,
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
  connectionKind?: 'oauth' | 'public_feed';
  providerAccountId: string;
  accountLabel: string;
  encryptedAccessToken?: string;
  encryptedRefreshToken?: string;
  grantedScopes: readonly string[];
  accessTokenExpiresAt?: Date;
  now: Date;
}

export interface UpsertImportedChannelInput {
  id: string;
  connectionId: string;
  sourceChannelId: string;
  sourceCatalogueId?: string;
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
  upsertImportedChannels(
    input: readonly UpsertImportedChannelInput[],
  ): Promise<readonly { id: string; sourceChannelId: string }[]>;
  enqueueSyncJobs(input: {
    id: string;
    importedChannelIds: readonly string[];
    now: Date;
  }): Promise<void>;
  listImportedChannelsByOwnerId(ownerId: string): Promise<ImportedChannel[]>;
}

function importedChannelFromRow(row: {
  id: string;
  provider: ChannelImportProvider;
  connectionKind: 'oauth' | 'public_feed';
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
    access: row.connectionKind === 'public_feed' ? 'public' : 'authorised',
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
  private readonly states = new Map<
    string,
    CreateChannelImportOAuthStateInput & { consumedAt?: Date }
  >();
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
    if (
      !state ||
      state.provider !== input.provider ||
      state.consumedAt ||
      state.expiresAt <= input.now
    ) {
      return undefined;
    }
    state.consumedAt = input.now;
    return { ownerId: state.ownerId };
  }

  async upsertConnection(input: UpsertChannelImportConnectionInput): Promise<{ id: string }> {
    const key = [input.ownerId, input.provider, input.providerAccountId].join(':');
    const existing = this.connections.get(key);
    const connection = {
      ...input,
      connectionKind: input.connectionKind ?? 'oauth',
      id: existing?.id ?? input.id,
    };
    this.connections.set(key, connection);
    return { id: connection.id };
  }

  async upsertImportedChannels(
    input: readonly UpsertImportedChannelInput[],
  ): Promise<readonly { id: string; sourceChannelId: string }[]> {
    return input.map((item) => {
      const key = [item.connectionId, item.sourceChannelId].join(':');
      const existing = this.imports.get(key);
      const imported = {
        ...item,
        id: existing?.id ?? item.id,
        importedVideoCount: existing?.importedVideoCount ?? 0,
        ...(existing?.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
      };
      this.imports.set(key, imported);
      return { id: imported.id, sourceChannelId: imported.sourceChannelId };
    });
  }

  async enqueueSyncJobs(input: {
    id: string;
    importedChannelIds: readonly string[];
    now: Date;
  }): Promise<void> {
    const importedIds = new Set(input.importedChannelIds);
    for (const imported of this.imports.values()) {
      if (importedIds.has(imported.id)) imported.status = 'syncing';
    }
  }

  async listImportedChannelsByOwnerId(ownerId: string): Promise<ImportedChannel[]> {
    const ownerConnectionIds = new Set(
      [...this.connections.values()]
        .filter((connection) => connection.ownerId === ownerId && !connection.revokedAt)
        .map((connection) => connection.id),
    );
    const connectionsById = new Map(
      [...this.connections.values()].map((connection) => [connection.id, connection]),
    );
    return [...this.imports.values()]
      .filter((channel) => ownerConnectionIds.has(channel.connectionId))
      .sort((left, right) => right.now.getTime() - left.now.getTime())
      .flatMap((channel) => {
        const connection = connectionsById.get(channel.connectionId);
        if (!connection) return [];
        return [
          {
            id: channel.id,
            provider: connection.provider,
            access: connection.connectionKind === 'public_feed' ? 'public' : 'authorised',
            sourceChannelId: channel.sourceChannelId,
            title: channel.title,
            sourceUrl: channel.sourceUrl,
            ...(channel.thumbnailUrl ? { thumbnailUrl: channel.thumbnailUrl } : {}),
            status: channel.status,
            importedVideoCount: channel.importedVideoCount,
            ...(channel.lastSyncedAt ? { lastSyncedAt: channel.lastSyncedAt.toISOString() } : {}),
          },
        ];
      });
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
        connectionKind: input.connectionKind ?? 'oauth',
        providerAccountId: input.providerAccountId,
        accountLabel: input.accountLabel,
        encryptedAccessToken: input.encryptedAccessToken ?? null,
        ...(input.encryptedRefreshToken
          ? { encryptedRefreshToken: input.encryptedRefreshToken }
          : {}),
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
          connectionKind: input.connectionKind ?? 'oauth',
          accountLabel: input.accountLabel,
          encryptedAccessToken: input.encryptedAccessToken ?? null,
          encryptedRefreshToken: input.encryptedRefreshToken ?? null,
          grantedScopes: [...input.grantedScopes],
          accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
          revokedAt: null,
          updatedAt: input.now,
        },
      })
      .returning({ id: channelImportConnections.id });
    if (!connection) throw new Error('Unable to persist channel-import connection.');
    return connection;
  }

  async upsertImportedChannels(
    input: readonly UpsertImportedChannelInput[],
  ): Promise<readonly { id: string; sourceChannelId: string }[]> {
    const result: { id: string; sourceChannelId: string }[] = [];
    for (const item of input) {
      const [channel] = await this.db
        .insert(importedChannels)
        .values({
          id: item.id,
          connectionId: item.connectionId,
          sourceChannelId: item.sourceChannelId,
          ...(item.sourceCatalogueId ? { sourceCatalogueId: item.sourceCatalogueId } : {}),
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
            ...(item.sourceCatalogueId ? { sourceCatalogueId: item.sourceCatalogueId } : {}),
            title: item.title,
            sourceUrl: item.sourceUrl,
            ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
            status: item.status,
            failureReason: null,
            updatedAt: item.now,
          },
        })
        .returning({ id: importedChannels.id, sourceChannelId: importedChannels.sourceChannelId });
      if (!channel) throw new Error('Unable to persist imported channel.');
      result.push(channel);
    }
    return result;
  }

  async enqueueSyncJobs(input: {
    id: string;
    importedChannelIds: readonly string[];
    now: Date;
  }): Promise<void> {
    for (const importedChannelId of input.importedChannelIds) {
      await this.db
        .insert(channelImportSyncJobs)
        .values({
          id: `${input.id}:${importedChannelId}`,
          importedChannelId,
          status: 'queued',
          nextCursor: null,
          attemptCount: 0,
          lockedUntil: null,
          failureReason: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [channelImportSyncJobs.importedChannelId],
          set: {
            status: 'queued',
            nextCursor: null,
            attemptCount: 0,
            lockedUntil: null,
            failureReason: null,
            updatedAt: input.now,
          },
        });
      await this.db
        .update(importedChannels)
        .set({ status: 'syncing', failureReason: null, updatedAt: input.now })
        .where(eq(importedChannels.id, importedChannelId));
    }
  }

  async listImportedChannelsByOwnerId(ownerId: string): Promise<ImportedChannel[]> {
    const rows = await this.db
      .select({
        id: importedChannels.id,
        provider: channelImportConnections.provider,
        connectionKind: channelImportConnections.connectionKind,
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
        and(
          eq(channelImportConnections.ownerId, ownerId),
          isNull(channelImportConnections.revokedAt),
        ),
      )
      .orderBy(desc(importedChannels.updatedAt));
    return rows.map(importedChannelFromRow);
  }
}
