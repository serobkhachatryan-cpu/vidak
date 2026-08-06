import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import { w3dsPrivateAdapterOutbox, w3dsPrivateAdapterProjections } from './db/schema';
import type {
  W3dsPrivateAdapterEntityType,
  W3dsPrivateAdapterOutboxRecord,
  W3dsPrivateAdapterProjectionRecord,
  W3dsPrivateAdapterSyncOperation,
  W3dsPrivateAdapterSyncStatus,
} from './w3ds-private-adapter-sync-types';

export type {
  W3dsPrivateAdapterEntityType,
  W3dsPrivateAdapterOutboxRecord,
  W3dsPrivateAdapterProjectionRecord,
  W3dsPrivateAdapterSyncOperation,
  W3dsPrivateAdapterSyncStatus,
};

export interface UpsertPrivateAdapterProjectionInput {
  id?: string;
  entityType: W3dsPrivateAdapterEntityType;
  localId: string;
  globalId: string;
  schemaId: string;
  ownerEName: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  mappingVersion: number;
  now: number;
}

export interface UpsertPrivateAdapterOutboxInput {
  id: string;
  entityType: W3dsPrivateAdapterEntityType;
  localId: string;
  operation: W3dsPrivateAdapterSyncOperation;
  syncStatus: W3dsPrivateAdapterSyncStatus;
  correlationId?: string;
  now: number;
}

export interface MarkPrivateAdapterOutboxAttemptInput {
  id: string;
  syncStatus: W3dsPrivateAdapterSyncStatus;
  attemptCount: number;
  lastAttemptedAt: string;
  lastSyncedAt?: string;
  failureReason?: string | null;
  correlationId?: string | null;
}

export interface W3dsPrivateAdapterSyncStore {
  getProjection(
    entityType: W3dsPrivateAdapterEntityType,
    localId: string,
  ): Promise<W3dsPrivateAdapterProjectionRecord | undefined>;
  getProjectionByGlobalId(
    globalId: string,
  ): Promise<W3dsPrivateAdapterProjectionRecord | undefined>;
  upsertProjection(
    input: UpsertPrivateAdapterProjectionInput,
  ): Promise<W3dsPrivateAdapterProjectionRecord>;
  getOutbox(
    entityType: W3dsPrivateAdapterEntityType,
    localId: string,
  ): Promise<W3dsPrivateAdapterOutboxRecord | undefined>;
  upsertOutbox(input: UpsertPrivateAdapterOutboxInput): Promise<W3dsPrivateAdapterOutboxRecord>;
  markOutboxAttempt(
    input: MarkPrivateAdapterOutboxAttemptInput,
  ): Promise<W3dsPrivateAdapterOutboxRecord>;
  listOutboxByStatus(
    syncStatus: W3dsPrivateAdapterSyncStatus,
  ): Promise<W3dsPrivateAdapterOutboxRecord[]>;
}

function cloneProjection(
  record: W3dsPrivateAdapterProjectionRecord,
): W3dsPrivateAdapterProjectionRecord {
  return { ...record, payload: { ...record.payload } };
}

function cloneOutbox(record: W3dsPrivateAdapterOutboxRecord): W3dsPrivateAdapterOutboxRecord {
  return { ...record };
}

function projectionFromRow(row: {
  id: string;
  entityType: W3dsPrivateAdapterEntityType;
  localId: string;
  globalId: string;
  schemaId: string;
  ownerEName: string;
  ownership: string;
  catalogueVisibility: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  mappingVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): W3dsPrivateAdapterProjectionRecord {
  return {
    id: row.id,
    entityType: row.entityType,
    localId: row.localId,
    globalId: row.globalId,
    schemaId: row.schemaId,
    ownerEName: row.ownerEName,
    ownership: 'vidak_private',
    catalogueVisibility: 'private',
    payload: row.payload,
    payloadHash: row.payloadHash,
    mappingVersion: row.mappingVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function outboxFromRow(row: {
  id: string;
  entityType: W3dsPrivateAdapterEntityType;
  localId: string;
  operation: W3dsPrivateAdapterSyncOperation;
  syncStatus: W3dsPrivateAdapterSyncStatus;
  attemptCount: number;
  lastAttemptedAt: Date | null;
  lastSyncedAt: Date | null;
  failureReason: string | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): W3dsPrivateAdapterOutboxRecord {
  return {
    id: row.id,
    entityType: row.entityType,
    localId: row.localId,
    operation: row.operation,
    syncStatus: row.syncStatus,
    attemptCount: row.attemptCount,
    ...(row.lastAttemptedAt ? { lastAttemptedAt: row.lastAttemptedAt.toISOString() } : {}),
    ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt.toISOString() } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.correlationId ? { correlationId: row.correlationId } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Stable hash of projection payload for idempotent unchanged detection. */
export function hashPrivateAdapterPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** In-memory store for unit tests only. */
export class InMemoryW3dsPrivateAdapterSyncStore implements W3dsPrivateAdapterSyncStore {
  private readonly projections = new Map<string, W3dsPrivateAdapterProjectionRecord>();
  private readonly outbox = new Map<string, W3dsPrivateAdapterOutboxRecord>();

  private projectionKey(entityType: W3dsPrivateAdapterEntityType, localId: string): string {
    return `${entityType}:${localId}`;
  }

  async getProjection(
    entityType: W3dsPrivateAdapterEntityType,
    localId: string,
  ): Promise<W3dsPrivateAdapterProjectionRecord | undefined> {
    const found = this.projections.get(this.projectionKey(entityType, localId));
    return found ? cloneProjection(found) : undefined;
  }

  async getProjectionByGlobalId(
    globalId: string,
  ): Promise<W3dsPrivateAdapterProjectionRecord | undefined> {
    const found = [...this.projections.values()].find((record) => record.globalId === globalId);
    return found ? cloneProjection(found) : undefined;
  }

  async upsertProjection(
    input: UpsertPrivateAdapterProjectionInput,
  ): Promise<W3dsPrivateAdapterProjectionRecord> {
    const key = this.projectionKey(input.entityType, input.localId);
    const existing = this.projections.get(key);
    const nowIso = new Date(input.now).toISOString();
    if (existing) {
      if (existing.globalId !== input.globalId) {
        throw new Error(
          `Private projection for ${input.entityType}/${input.localId} cannot change globalId.`,
        );
      }
      if (existing.ownerEName !== input.ownerEName) {
        throw new Error(
          `Private projection for ${input.entityType}/${input.localId} cannot change owner eName.`,
        );
      }
      if (existing.schemaId !== input.schemaId) {
        throw new Error(
          `Private projection for ${input.entityType}/${input.localId} cannot change schemaId.`,
        );
      }
      const updated: W3dsPrivateAdapterProjectionRecord = {
        ...existing,
        payload: { ...input.payload },
        payloadHash: input.payloadHash,
        mappingVersion: input.mappingVersion,
        updatedAt: nowIso,
      };
      this.projections.set(key, updated);
      return cloneProjection(updated);
    }

    const created: W3dsPrivateAdapterProjectionRecord = {
      id: input.id ?? randomUUID(),
      entityType: input.entityType,
      localId: input.localId,
      globalId: input.globalId,
      schemaId: input.schemaId,
      ownerEName: input.ownerEName,
      ownership: 'vidak_private',
      catalogueVisibility: 'private',
      payload: { ...input.payload },
      payloadHash: input.payloadHash,
      mappingVersion: input.mappingVersion,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.projections.set(key, created);
    return cloneProjection(created);
  }

  async getOutbox(
    entityType: W3dsPrivateAdapterEntityType,
    localId: string,
  ): Promise<W3dsPrivateAdapterOutboxRecord | undefined> {
    const found = this.outbox.get(this.projectionKey(entityType, localId));
    return found ? cloneOutbox(found) : undefined;
  }

  async upsertOutbox(
    input: UpsertPrivateAdapterOutboxInput,
  ): Promise<W3dsPrivateAdapterOutboxRecord> {
    const key = this.projectionKey(input.entityType, input.localId);
    const existing = this.outbox.get(key);
    const nowIso = new Date(input.now).toISOString();
    if (existing) {
      const updated: W3dsPrivateAdapterOutboxRecord = {
        ...existing,
        operation: input.operation,
        syncStatus: 'pending',
        updatedAt: nowIso,
      };
      delete updated.failureReason;
      if (input.correlationId) {
        updated.correlationId = input.correlationId;
      }
      this.outbox.set(key, updated);
      return cloneOutbox(updated);
    }
    const created: W3dsPrivateAdapterOutboxRecord = {
      id: input.id,
      entityType: input.entityType,
      localId: input.localId,
      operation: input.operation,
      syncStatus: input.syncStatus,
      attemptCount: 0,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.outbox.set(key, created);
    return cloneOutbox(created);
  }

  async markOutboxAttempt(
    input: MarkPrivateAdapterOutboxAttemptInput,
  ): Promise<W3dsPrivateAdapterOutboxRecord> {
    const existing = [...this.outbox.values()].find((record) => record.id === input.id);
    if (!existing) {
      throw new Error(`Private adapter outbox row ${input.id} was not found.`);
    }
    const updated: W3dsPrivateAdapterOutboxRecord = {
      ...existing,
      syncStatus: input.syncStatus,
      attemptCount: input.attemptCount,
      lastAttemptedAt: input.lastAttemptedAt,
      updatedAt: new Date().toISOString(),
    };
    if (input.lastSyncedAt) {
      updated.lastSyncedAt = input.lastSyncedAt;
    }
    if (input.failureReason === null) {
      delete updated.failureReason;
    } else if (input.failureReason) {
      updated.failureReason = input.failureReason;
    }
    if (input.correlationId === null) {
      delete updated.correlationId;
    } else if (input.correlationId) {
      updated.correlationId = input.correlationId;
    }
    this.outbox.set(this.projectionKey(updated.entityType, updated.localId), updated);
    return cloneOutbox(updated);
  }

  async listOutboxByStatus(
    syncStatus: W3dsPrivateAdapterSyncStatus,
  ): Promise<W3dsPrivateAdapterOutboxRecord[]> {
    return [...this.outbox.values()]
      .filter((record) => record.syncStatus === syncStatus)
      .map(cloneOutbox)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/** PostgreSQL-backed private adapter sync store. */
export class PostgresW3dsPrivateAdapterSyncStore implements W3dsPrivateAdapterSyncStore {
  constructor(private readonly db: W3dsDatabase) {}

  async getProjection(
    entityType: W3dsPrivateAdapterEntityType,
    localId: string,
  ): Promise<W3dsPrivateAdapterProjectionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsPrivateAdapterProjections)
      .where(
        and(
          eq(w3dsPrivateAdapterProjections.entityType, entityType),
          eq(w3dsPrivateAdapterProjections.localId, localId),
        ),
      )
      .limit(1);
    return row ? projectionFromRow(row) : undefined;
  }

  async getProjectionByGlobalId(
    globalId: string,
  ): Promise<W3dsPrivateAdapterProjectionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsPrivateAdapterProjections)
      .where(eq(w3dsPrivateAdapterProjections.globalId, globalId))
      .limit(1);
    return row ? projectionFromRow(row) : undefined;
  }

  async upsertProjection(
    input: UpsertPrivateAdapterProjectionInput,
  ): Promise<W3dsPrivateAdapterProjectionRecord> {
    const existing = await this.getProjection(input.entityType, input.localId);
    const now = new Date(input.now);

    if (existing) {
      if (existing.globalId !== input.globalId) {
        throw new Error(
          `Private projection for ${input.entityType}/${input.localId} cannot change globalId.`,
        );
      }
      if (existing.ownerEName !== input.ownerEName) {
        throw new Error(
          `Private projection for ${input.entityType}/${input.localId} cannot change owner eName.`,
        );
      }
      if (existing.schemaId !== input.schemaId) {
        throw new Error(
          `Private projection for ${input.entityType}/${input.localId} cannot change schemaId.`,
        );
      }
      const [updated] = await this.db
        .update(w3dsPrivateAdapterProjections)
        .set({
          payload: input.payload,
          payloadHash: input.payloadHash,
          mappingVersion: input.mappingVersion,
          updatedAt: now,
        })
        .where(eq(w3dsPrivateAdapterProjections.id, existing.id))
        .returning();
      if (!updated) {
        throw new Error('Unable to update the private adapter projection.');
      }
      return projectionFromRow(updated);
    }

    const [created] = await this.db
      .insert(w3dsPrivateAdapterProjections)
      .values({
        id: input.id ?? randomUUID(),
        entityType: input.entityType,
        localId: input.localId,
        globalId: input.globalId,
        schemaId: input.schemaId,
        ownerEName: input.ownerEName,
        ownership: 'vidak_private',
        catalogueVisibility: 'private',
        payload: input.payload,
        payloadHash: input.payloadHash,
        mappingVersion: input.mappingVersion,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (created) return projectionFromRow(created);

    const raced = await this.getProjection(input.entityType, input.localId);
    if (!raced) {
      throw new Error('Unable to persist the private adapter projection.');
    }
    return this.upsertProjection({ ...input, id: raced.id, globalId: raced.globalId });
  }

  async getOutbox(
    entityType: W3dsPrivateAdapterEntityType,
    localId: string,
  ): Promise<W3dsPrivateAdapterOutboxRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsPrivateAdapterOutbox)
      .where(
        and(
          eq(w3dsPrivateAdapterOutbox.entityType, entityType),
          eq(w3dsPrivateAdapterOutbox.localId, localId),
        ),
      )
      .limit(1);
    return row ? outboxFromRow(row) : undefined;
  }

  async upsertOutbox(
    input: UpsertPrivateAdapterOutboxInput,
  ): Promise<W3dsPrivateAdapterOutboxRecord> {
    const existing = await this.getOutbox(input.entityType, input.localId);
    const now = new Date(input.now);

    if (existing) {
      const [updated] = await this.db
        .update(w3dsPrivateAdapterOutbox)
        .set({
          operation: input.operation,
          syncStatus: 'pending',
          failureReason: null,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          updatedAt: now,
        })
        .where(eq(w3dsPrivateAdapterOutbox.id, existing.id))
        .returning();
      if (!updated) {
        throw new Error('Unable to update the private adapter outbox row.');
      }
      return outboxFromRow(updated);
    }

    const [created] = await this.db
      .insert(w3dsPrivateAdapterOutbox)
      .values({
        id: input.id,
        entityType: input.entityType,
        localId: input.localId,
        operation: input.operation,
        syncStatus: input.syncStatus,
        attemptCount: 0,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (created) return outboxFromRow(created);

    const raced = await this.getOutbox(input.entityType, input.localId);
    if (!raced) {
      throw new Error('Unable to persist the private adapter outbox row.');
    }
    return this.upsertOutbox({ ...input, id: raced.id });
  }

  async markOutboxAttempt(
    input: MarkPrivateAdapterOutboxAttemptInput,
  ): Promise<W3dsPrivateAdapterOutboxRecord> {
    const [updated] = await this.db
      .update(w3dsPrivateAdapterOutbox)
      .set({
        syncStatus: input.syncStatus,
        attemptCount: input.attemptCount,
        lastAttemptedAt: new Date(input.lastAttemptedAt),
        ...(input.lastSyncedAt ? { lastSyncedAt: new Date(input.lastSyncedAt) } : {}),
        failureReason: input.failureReason === undefined ? undefined : input.failureReason,
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        updatedAt: new Date(),
      })
      .where(eq(w3dsPrivateAdapterOutbox.id, input.id))
      .returning();
    if (!updated) {
      throw new Error(`Private adapter outbox row ${input.id} was not found.`);
    }
    return outboxFromRow(updated);
  }

  async listOutboxByStatus(
    syncStatus: W3dsPrivateAdapterSyncStatus,
  ): Promise<W3dsPrivateAdapterOutboxRecord[]> {
    const rows = await this.db
      .select()
      .from(w3dsPrivateAdapterOutbox)
      .where(eq(w3dsPrivateAdapterOutbox.syncStatus, syncStatus));
    return rows.map(outboxFromRow).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
