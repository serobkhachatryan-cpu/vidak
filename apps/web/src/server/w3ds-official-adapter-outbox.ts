/**
 * Durable official-adapter outbox.
 *
 * Distinct from w3ds_private_adapter_outbox. Retries of the same local change
 * upsert one (entityType, localId) row. Never treats private projection UUIDs
 * as MetaEnvelope IDs.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import { w3dsOfficialAdapterOutbox } from './db/schema';

export type W3dsOfficialAdapterEntityType = 'channel' | 'video' | 'playlist' | 'comment';
export type W3dsOfficialAdapterSyncStatus = 'pending' | 'synced' | 'failed';
export type W3dsOfficialAdapterSyncOperation = 'upsert';

export interface W3dsOfficialAdapterOutboxRecord {
  id: string;
  entityType: W3dsOfficialAdapterEntityType;
  localId: string;
  operation: W3dsOfficialAdapterSyncOperation;
  syncStatus: W3dsOfficialAdapterSyncStatus;
  attemptCount: number;
  lastAttemptedAt?: string;
  lastSyncedAt?: string;
  failureReason?: string;
  correlationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertOfficialAdapterOutboxInput {
  id: string;
  entityType: W3dsOfficialAdapterEntityType;
  localId: string;
  operation: W3dsOfficialAdapterSyncOperation;
  syncStatus: W3dsOfficialAdapterSyncStatus;
  correlationId?: string;
  now: number;
}

export interface MarkOfficialAdapterOutboxAttemptInput {
  id: string;
  syncStatus: W3dsOfficialAdapterSyncStatus;
  attemptCount: number;
  lastAttemptedAt: string;
  lastSyncedAt?: string;
  failureReason?: string | null;
  correlationId?: string | null;
}

export interface W3dsOfficialAdapterOutboxStore {
  getOutbox(
    entityType: W3dsOfficialAdapterEntityType,
    localId: string,
  ): Promise<W3dsOfficialAdapterOutboxRecord | undefined>;
  upsertOutbox(input: UpsertOfficialAdapterOutboxInput): Promise<W3dsOfficialAdapterOutboxRecord>;
  markOutboxAttempt(
    input: MarkOfficialAdapterOutboxAttemptInput,
  ): Promise<W3dsOfficialAdapterOutboxRecord>;
  listOutboxByStatus(
    syncStatus: W3dsOfficialAdapterSyncStatus,
  ): Promise<W3dsOfficialAdapterOutboxRecord[]>;
}

function cloneOutbox(record: W3dsOfficialAdapterOutboxRecord): W3dsOfficialAdapterOutboxRecord {
  return { ...record };
}

function outboxFromRow(row: {
  id: string;
  entityType: W3dsOfficialAdapterEntityType;
  localId: string;
  operation: W3dsOfficialAdapterSyncOperation;
  syncStatus: W3dsOfficialAdapterSyncStatus;
  attemptCount: number;
  lastAttemptedAt: Date | null;
  lastSyncedAt: Date | null;
  failureReason: string | null;
  correlationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): W3dsOfficialAdapterOutboxRecord {
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

/** In-memory store for unit tests only. */
export class InMemoryW3dsOfficialAdapterOutboxStore implements W3dsOfficialAdapterOutboxStore {
  private readonly outbox = new Map<string, W3dsOfficialAdapterOutboxRecord>();

  private key(entityType: W3dsOfficialAdapterEntityType, localId: string): string {
    return `${entityType}:${localId}`;
  }

  async getOutbox(
    entityType: W3dsOfficialAdapterEntityType,
    localId: string,
  ): Promise<W3dsOfficialAdapterOutboxRecord | undefined> {
    const found = this.outbox.get(this.key(entityType, localId));
    return found ? cloneOutbox(found) : undefined;
  }

  async upsertOutbox(
    input: UpsertOfficialAdapterOutboxInput,
  ): Promise<W3dsOfficialAdapterOutboxRecord> {
    const key = this.key(input.entityType, input.localId);
    const existing = this.outbox.get(key);
    const nowIso = new Date(input.now).toISOString();
    if (existing) {
      const updated: W3dsOfficialAdapterOutboxRecord = {
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
    const created: W3dsOfficialAdapterOutboxRecord = {
      id: input.id || randomUUID(),
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
    input: MarkOfficialAdapterOutboxAttemptInput,
  ): Promise<W3dsOfficialAdapterOutboxRecord> {
    const existing = [...this.outbox.values()].find((record) => record.id === input.id);
    if (!existing) {
      throw new Error(`Official adapter outbox row ${input.id} was not found.`);
    }
    const updated: W3dsOfficialAdapterOutboxRecord = {
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
    this.outbox.set(this.key(updated.entityType, updated.localId), updated);
    return cloneOutbox(updated);
  }

  async listOutboxByStatus(
    syncStatus: W3dsOfficialAdapterSyncStatus,
  ): Promise<W3dsOfficialAdapterOutboxRecord[]> {
    return [...this.outbox.values()]
      .filter((record) => record.syncStatus === syncStatus)
      .map(cloneOutbox)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/** PostgreSQL-backed official adapter outbox. */
export class PostgresW3dsOfficialAdapterOutboxStore implements W3dsOfficialAdapterOutboxStore {
  constructor(private readonly db: W3dsDatabase) {}

  async getOutbox(
    entityType: W3dsOfficialAdapterEntityType,
    localId: string,
  ): Promise<W3dsOfficialAdapterOutboxRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsOfficialAdapterOutbox)
      .where(
        and(
          eq(w3dsOfficialAdapterOutbox.entityType, entityType),
          eq(w3dsOfficialAdapterOutbox.localId, localId),
        ),
      )
      .limit(1);
    return row ? outboxFromRow(row) : undefined;
  }

  async upsertOutbox(
    input: UpsertOfficialAdapterOutboxInput,
  ): Promise<W3dsOfficialAdapterOutboxRecord> {
    const existing = await this.getOutbox(input.entityType, input.localId);
    const now = new Date(input.now);

    if (existing) {
      const [updated] = await this.db
        .update(w3dsOfficialAdapterOutbox)
        .set({
          operation: input.operation,
          syncStatus: 'pending',
          failureReason: null,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          updatedAt: now,
        })
        .where(eq(w3dsOfficialAdapterOutbox.id, existing.id))
        .returning();
      if (!updated) {
        throw new Error('Unable to update the official adapter outbox row.');
      }
      return outboxFromRow(updated);
    }

    const [created] = await this.db
      .insert(w3dsOfficialAdapterOutbox)
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
      throw new Error('Unable to persist the official adapter outbox row.');
    }
    return this.upsertOutbox({ ...input, id: raced.id });
  }

  async markOutboxAttempt(
    input: MarkOfficialAdapterOutboxAttemptInput,
  ): Promise<W3dsOfficialAdapterOutboxRecord> {
    const [updated] = await this.db
      .update(w3dsOfficialAdapterOutbox)
      .set({
        syncStatus: input.syncStatus,
        attemptCount: input.attemptCount,
        lastAttemptedAt: new Date(input.lastAttemptedAt),
        ...(input.lastSyncedAt ? { lastSyncedAt: new Date(input.lastSyncedAt) } : {}),
        failureReason: input.failureReason === undefined ? undefined : input.failureReason,
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        updatedAt: new Date(),
      })
      .where(eq(w3dsOfficialAdapterOutbox.id, input.id))
      .returning();
    if (!updated) {
      throw new Error(`Official adapter outbox row ${input.id} was not found.`);
    }
    return outboxFromRow(updated);
  }

  async listOutboxByStatus(
    syncStatus: W3dsOfficialAdapterSyncStatus,
  ): Promise<W3dsOfficialAdapterOutboxRecord[]> {
    const rows = await this.db
      .select()
      .from(w3dsOfficialAdapterOutbox)
      .where(eq(w3dsOfficialAdapterOutbox.syncStatus, syncStatus));
    return rows.map(outboxFromRow).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
