import { and, eq } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import {
  type W3dsAuthorizationAccessScope,
  type W3dsAuthorizationResourceKind,
  type W3dsAuthorizationSyncIntent,
  type W3dsAuthorizationSyncStatus,
  w3dsAuthorizationSync,
} from './db/schema';

export type {
  W3dsAuthorizationAccessScope,
  W3dsAuthorizationResourceKind,
  W3dsAuthorizationSyncIntent,
  W3dsAuthorizationSyncStatus,
};

/**
 * Server-only durable sync record. Failure reasons are already redacted.
 */
export interface W3dsAuthorizationSyncRecord {
  id: string;
  resourceKind: W3dsAuthorizationResourceKind;
  resourceId: string;
  localResourceId: string;
  ownerPlatformUserId: string;
  ownerEName: string;
  subjectPlatformUserId?: string;
  subjectEName: string;
  subjectEVaultId?: string;
  scope: W3dsAuthorizationAccessScope;
  intent: W3dsAuthorizationSyncIntent;
  syncStatus: W3dsAuthorizationSyncStatus;
  externalGrantId?: string;
  externalOwnerBindingId?: string;
  attemptCount: number;
  lastAttemptedAt?: string;
  lastSyncedAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertW3dsAuthorizationSyncIntentInput {
  id: string;
  resourceKind: W3dsAuthorizationResourceKind;
  resourceId: string;
  localResourceId: string;
  ownerPlatformUserId: string;
  ownerEName: string;
  subjectPlatformUserId?: string;
  subjectEName: string;
  subjectEVaultId?: string;
  scope: W3dsAuthorizationAccessScope;
  intent: W3dsAuthorizationSyncIntent;
  /** Initial status when inserting; updates always move to pending unless already terminal match. */
  syncStatus: W3dsAuthorizationSyncStatus;
}

export interface MarkW3dsAuthorizationSyncAttemptInput {
  id: string;
  syncStatus: W3dsAuthorizationSyncStatus;
  attemptCount: number;
  lastAttemptedAt: string;
  lastSyncedAt?: string;
  externalGrantId?: string | null;
  externalOwnerBindingId?: string | null;
  failureReason?: string | null;
}

/**
 * Durable persistence for W3DS authorization sync intents.
 * Runtime production uses PostgreSQL; in-memory exists only for unit tests.
 */
export interface W3dsAuthorizationSyncStore {
  getByResourceSubjectScope(
    resourceId: string,
    subjectEName: string,
    scope: W3dsAuthorizationAccessScope,
  ): Promise<W3dsAuthorizationSyncRecord | undefined>;
  listByResourceId(resourceId: string): Promise<W3dsAuthorizationSyncRecord[]>;
  /**
   * Inserts or updates the durable intent for (resource, subject, scope).
   * Changing intent always resets status to pending for a fresh remote attempt.
   */
  upsertIntent(input: UpsertW3dsAuthorizationSyncIntentInput): Promise<W3dsAuthorizationSyncRecord>;
  markAttempt(input: MarkW3dsAuthorizationSyncAttemptInput): Promise<W3dsAuthorizationSyncRecord>;
}

function cloneRecord(record: W3dsAuthorizationSyncRecord): W3dsAuthorizationSyncRecord {
  return { ...record };
}

function toRecord(row: {
  id: string;
  resourceKind: W3dsAuthorizationResourceKind;
  resourceId: string;
  localResourceId: string;
  ownerPlatformUserId: string;
  ownerEName: string;
  subjectPlatformUserId: string | null;
  subjectEName: string;
  subjectEVaultId: string | null;
  scope: W3dsAuthorizationAccessScope;
  intent: W3dsAuthorizationSyncIntent;
  syncStatus: W3dsAuthorizationSyncStatus;
  externalGrantId: string | null;
  externalOwnerBindingId: string | null;
  attemptCount: number;
  lastAttemptedAt: Date | null;
  lastSyncedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): W3dsAuthorizationSyncRecord {
  return {
    id: row.id,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    localResourceId: row.localResourceId,
    ownerPlatformUserId: row.ownerPlatformUserId,
    ownerEName: row.ownerEName,
    ...(row.subjectPlatformUserId ? { subjectPlatformUserId: row.subjectPlatformUserId } : {}),
    subjectEName: row.subjectEName,
    ...(row.subjectEVaultId ? { subjectEVaultId: row.subjectEVaultId } : {}),
    scope: row.scope,
    intent: row.intent,
    syncStatus: row.syncStatus,
    ...(row.externalGrantId ? { externalGrantId: row.externalGrantId } : {}),
    ...(row.externalOwnerBindingId ? { externalOwnerBindingId: row.externalOwnerBindingId } : {}),
    attemptCount: row.attemptCount,
    ...(row.lastAttemptedAt ? { lastAttemptedAt: row.lastAttemptedAt.toISOString() } : {}),
    ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt.toISOString() } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class InMemoryW3dsAuthorizationSyncStore implements W3dsAuthorizationSyncStore {
  private readonly records = new Map<string, W3dsAuthorizationSyncRecord>();

  async getByResourceSubjectScope(
    resourceId: string,
    subjectEName: string,
    scope: W3dsAuthorizationAccessScope,
  ): Promise<W3dsAuthorizationSyncRecord | undefined> {
    const found = [...this.records.values()].find(
      (record) =>
        record.resourceId === resourceId &&
        record.subjectEName === subjectEName &&
        record.scope === scope,
    );
    return found ? cloneRecord(found) : undefined;
  }

  async listByResourceId(resourceId: string): Promise<W3dsAuthorizationSyncRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.resourceId === resourceId)
      .map(cloneRecord)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async upsertIntent(
    input: UpsertW3dsAuthorizationSyncIntentInput,
  ): Promise<W3dsAuthorizationSyncRecord> {
    const existing = await this.getByResourceSubjectScope(
      input.resourceId,
      input.subjectEName,
      input.scope,
    );
    const now = new Date().toISOString();
    if (!existing) {
      const created: W3dsAuthorizationSyncRecord = {
        id: input.id,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        localResourceId: input.localResourceId,
        ownerPlatformUserId: input.ownerPlatformUserId,
        ownerEName: input.ownerEName,
        ...(input.subjectPlatformUserId
          ? { subjectPlatformUserId: input.subjectPlatformUserId }
          : {}),
        subjectEName: input.subjectEName,
        ...(input.subjectEVaultId ? { subjectEVaultId: input.subjectEVaultId } : {}),
        scope: input.scope,
        intent: input.intent,
        syncStatus: input.syncStatus,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.records.set(created.id, created);
      return cloneRecord(created);
    }

    const intentChanged = existing.intent !== input.intent;
    const nextStatus: W3dsAuthorizationSyncStatus = intentChanged
      ? 'pending'
      : existing.syncStatus === 'synced' || existing.syncStatus === 'revoked'
        ? existing.syncStatus
        : 'pending';
    const updated: W3dsAuthorizationSyncRecord = {
      id: existing.id,
      resourceKind: input.resourceKind,
      resourceId: existing.resourceId,
      localResourceId: input.localResourceId,
      ownerPlatformUserId: input.ownerPlatformUserId,
      ownerEName: input.ownerEName,
      ...(input.subjectPlatformUserId
        ? { subjectPlatformUserId: input.subjectPlatformUserId }
        : {}),
      subjectEName: input.subjectEName,
      ...(input.subjectEVaultId ? { subjectEVaultId: input.subjectEVaultId } : {}),
      scope: input.scope,
      intent: input.intent,
      syncStatus: nextStatus,
      ...(existing.externalGrantId ? { externalGrantId: existing.externalGrantId } : {}),
      ...(existing.externalOwnerBindingId
        ? { externalOwnerBindingId: existing.externalOwnerBindingId }
        : {}),
      attemptCount: existing.attemptCount,
      ...(existing.lastAttemptedAt ? { lastAttemptedAt: existing.lastAttemptedAt } : {}),
      ...(existing.lastSyncedAt ? { lastSyncedAt: existing.lastSyncedAt } : {}),
      ...(!intentChanged && existing.failureReason
        ? { failureReason: existing.failureReason }
        : {}),
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    this.records.set(existing.id, updated);
    return cloneRecord(updated);
  }

  async markAttempt(
    input: MarkW3dsAuthorizationSyncAttemptInput,
  ): Promise<W3dsAuthorizationSyncRecord> {
    const existing = this.records.get(input.id);
    if (!existing) {
      throw new Error(`Authorization sync record ${input.id} was not found.`);
    }
    const updated: W3dsAuthorizationSyncRecord = {
      ...existing,
      syncStatus: input.syncStatus,
      attemptCount: input.attemptCount,
      lastAttemptedAt: input.lastAttemptedAt,
      updatedAt: new Date().toISOString(),
    };
    if (input.lastSyncedAt !== undefined) {
      if (input.lastSyncedAt) updated.lastSyncedAt = input.lastSyncedAt;
      else delete updated.lastSyncedAt;
    }
    if (input.externalGrantId !== undefined) {
      if (input.externalGrantId) updated.externalGrantId = input.externalGrantId;
      else delete updated.externalGrantId;
    }
    if (input.externalOwnerBindingId !== undefined) {
      if (input.externalOwnerBindingId) {
        updated.externalOwnerBindingId = input.externalOwnerBindingId;
      } else {
        delete updated.externalOwnerBindingId;
      }
    }
    if (input.failureReason !== undefined) {
      if (input.failureReason) updated.failureReason = input.failureReason;
      else delete updated.failureReason;
    }
    this.records.set(existing.id, updated);
    return cloneRecord(updated);
  }
}

export class PostgresW3dsAuthorizationSyncStore implements W3dsAuthorizationSyncStore {
  constructor(private readonly db: W3dsDatabase) {}

  async getByResourceSubjectScope(
    resourceId: string,
    subjectEName: string,
    scope: W3dsAuthorizationAccessScope,
  ): Promise<W3dsAuthorizationSyncRecord | undefined> {
    const rows = await this.db
      .select()
      .from(w3dsAuthorizationSync)
      .where(
        and(
          eq(w3dsAuthorizationSync.resourceId, resourceId),
          eq(w3dsAuthorizationSync.subjectEName, subjectEName),
          eq(w3dsAuthorizationSync.scope, scope),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row) : undefined;
  }

  async listByResourceId(resourceId: string): Promise<W3dsAuthorizationSyncRecord[]> {
    const rows = await this.db
      .select()
      .from(w3dsAuthorizationSync)
      .where(eq(w3dsAuthorizationSync.resourceId, resourceId));
    return rows.map(toRecord).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async upsertIntent(
    input: UpsertW3dsAuthorizationSyncIntentInput,
  ): Promise<W3dsAuthorizationSyncRecord> {
    const existing = await this.getByResourceSubjectScope(
      input.resourceId,
      input.subjectEName,
      input.scope,
    );
    const now = new Date();
    if (!existing) {
      const rows = await this.db
        .insert(w3dsAuthorizationSync)
        .values({
          id: input.id,
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
          localResourceId: input.localResourceId,
          ownerPlatformUserId: input.ownerPlatformUserId,
          ownerEName: input.ownerEName,
          subjectPlatformUserId: input.subjectPlatformUserId ?? null,
          subjectEName: input.subjectEName,
          subjectEVaultId: input.subjectEVaultId ?? null,
          scope: input.scope,
          intent: input.intent,
          syncStatus: input.syncStatus,
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error('Failed to insert authorization sync intent.');
      }
      return toRecord(row);
    }

    const intentChanged = existing.intent !== input.intent;
    const nextStatus: W3dsAuthorizationSyncStatus = intentChanged
      ? 'pending'
      : existing.syncStatus === 'synced' || existing.syncStatus === 'revoked'
        ? existing.syncStatus
        : 'pending';

    const rows = await this.db
      .update(w3dsAuthorizationSync)
      .set({
        resourceKind: input.resourceKind,
        localResourceId: input.localResourceId,
        ownerPlatformUserId: input.ownerPlatformUserId,
        ownerEName: input.ownerEName,
        subjectPlatformUserId: input.subjectPlatformUserId ?? null,
        subjectEVaultId: input.subjectEVaultId ?? null,
        intent: input.intent,
        syncStatus: nextStatus,
        ...(intentChanged ? { failureReason: null } : {}),
        updatedAt: now,
      })
      .where(eq(w3dsAuthorizationSync.id, existing.id))
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error('Failed to update authorization sync intent.');
    }
    return toRecord(row);
  }

  async markAttempt(
    input: MarkW3dsAuthorizationSyncAttemptInput,
  ): Promise<W3dsAuthorizationSyncRecord> {
    const rows = await this.db
      .update(w3dsAuthorizationSync)
      .set({
        syncStatus: input.syncStatus,
        attemptCount: input.attemptCount,
        lastAttemptedAt: new Date(input.lastAttemptedAt),
        ...(input.lastSyncedAt !== undefined
          ? { lastSyncedAt: input.lastSyncedAt ? new Date(input.lastSyncedAt) : null }
          : {}),
        ...(input.externalGrantId !== undefined ? { externalGrantId: input.externalGrantId } : {}),
        ...(input.externalOwnerBindingId !== undefined
          ? { externalOwnerBindingId: input.externalOwnerBindingId }
          : {}),
        ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
        updatedAt: new Date(),
      })
      .where(eq(w3dsAuthorizationSync.id, input.id))
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`Authorization sync record ${input.id} was not found.`);
    }
    return toRecord(row);
  }
}
