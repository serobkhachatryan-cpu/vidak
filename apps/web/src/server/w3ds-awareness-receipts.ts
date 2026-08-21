/// <reference path="./server-only-module.d.ts" />
/**
 * Durable AaaS webhook receipts keyed by MetaEnvelope id.
 * Slice 1: verified deliveries only. No product or adapter mapping writes.
 */

import { randomUUID } from 'node:crypto';
import 'server-only';
import { eq, ne } from 'drizzle-orm';
import { getW3dsDatabase, type W3dsDatabase } from './db/client';
import { w3dsAwarenessReceipts } from './db/schema';

export interface W3dsAwarenessReceiptRecord {
  id: string;
  globalId: string;
  /** SHA-256 of the authenticated raw AaaS delivery body; never raw payload data. */
  payloadHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordW3dsAwarenessReceiptInput {
  globalId: string;
  payloadHash: string;
  now: number;
}

export interface RecordW3dsAwarenessReceiptResult {
  receipt: W3dsAwarenessReceiptRecord;
  /** Exact authenticated retransmission of the stored raw payload. */
  outcome: 'duplicate' | 'changed';
}

export interface W3dsAwarenessReceiptStore {
  getByGlobalId(globalId: string): Promise<W3dsAwarenessReceiptRecord | undefined>;
  /**
   * Atomically stores an authenticated payload fingerprint. An exact replay is
   * a no-op; a changed payload for the same MetaEnvelope id updates the same
   * durable receipt so the caller can upsert its existing local projection.
   */
  recordReceipt(input: RecordW3dsAwarenessReceiptInput): Promise<RecordW3dsAwarenessReceiptResult>;
}

function cloneReceipt(record: W3dsAwarenessReceiptRecord): W3dsAwarenessReceiptRecord {
  return { ...record };
}

function recordFromRow(row: {
  id: string;
  globalId: string;
  payloadHash: string;
  createdAt: Date;
  updatedAt: Date;
}): W3dsAwarenessReceiptRecord {
  return {
    id: row.id,
    globalId: row.globalId,
    payloadHash: row.payloadHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** In-memory store for explicit unit tests only. */
export class InMemoryW3dsAwarenessReceiptStore implements W3dsAwarenessReceiptStore {
  private readonly records = new Map<string, W3dsAwarenessReceiptRecord>();

  async getByGlobalId(globalId: string): Promise<W3dsAwarenessReceiptRecord | undefined> {
    const found = this.records.get(globalId);
    return found ? cloneReceipt(found) : undefined;
  }

  async recordReceipt(
    input: RecordW3dsAwarenessReceiptInput,
  ): Promise<RecordW3dsAwarenessReceiptResult> {
    const existing = this.records.get(input.globalId);
    if (existing?.payloadHash === input.payloadHash) {
      return { receipt: cloneReceipt(existing), outcome: 'duplicate' };
    }

    const timestamp = new Date(input.now).toISOString();
    if (existing) {
      const changed = { ...existing, payloadHash: input.payloadHash, updatedAt: timestamp };
      this.records.set(input.globalId, changed);
      return { receipt: cloneReceipt(changed), outcome: 'changed' };
    }

    const created: W3dsAwarenessReceiptRecord = {
      id: randomUUID(),
      globalId: input.globalId,
      payloadHash: input.payloadHash,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.set(input.globalId, created);
    return { receipt: cloneReceipt(created), outcome: 'changed' };
  }
}

export class PostgresW3dsAwarenessReceiptStore implements W3dsAwarenessReceiptStore {
  constructor(private readonly db: W3dsDatabase) {}

  async getByGlobalId(globalId: string): Promise<W3dsAwarenessReceiptRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsAwarenessReceipts)
      .where(eq(w3dsAwarenessReceipts.globalId, globalId))
      .limit(1);
    return row ? recordFromRow(row) : undefined;
  }

  async recordReceipt(
    input: RecordW3dsAwarenessReceiptInput,
  ): Promise<RecordW3dsAwarenessReceiptResult> {
    const [changed] = await this.db
      .insert(w3dsAwarenessReceipts)
      .values({
        id: randomUUID(),
        globalId: input.globalId,
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

    if (changed) return { receipt: recordFromRow(changed), outcome: 'changed' };

    const existing = await this.getByGlobalId(input.globalId);
    if (!existing) {
      throw new Error('Unable to persist the Awareness webhook receipt.');
    }
    return { receipt: existing, outcome: 'duplicate' };
  }
}

export function createPostgresW3dsAwarenessReceiptStore(
  db: W3dsDatabase = getW3dsDatabase(),
): PostgresW3dsAwarenessReceiptStore {
  return new PostgresW3dsAwarenessReceiptStore(db);
}
