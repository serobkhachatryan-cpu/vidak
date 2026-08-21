/// <reference path="./server-only-module.d.ts" />
/**
 * Durable AaaS webhook receipts keyed by MetaEnvelope id.
 * Slice 1: verified deliveries only. No product or adapter mapping writes.
 */

import { randomUUID } from 'node:crypto';
import 'server-only';
import { eq } from 'drizzle-orm';
import { getW3dsDatabase, type W3dsDatabase } from './db/client';
import { w3dsAwarenessReceipts } from './db/schema';

export interface W3dsAwarenessReceiptRecord {
  id: string;
  globalId: string;
  createdAt: string;
}

export interface RecordW3dsAwarenessReceiptInput {
  globalId: string;
  now: number;
}

export interface W3dsAwarenessReceiptStore {
  getByGlobalId(globalId: string): Promise<W3dsAwarenessReceiptRecord | undefined>;
  /**
   * Inserts a receipt for globalId. The same id returns the existing row.
   */
  recordReceipt(input: RecordW3dsAwarenessReceiptInput): Promise<W3dsAwarenessReceiptRecord>;
}

function cloneReceipt(record: W3dsAwarenessReceiptRecord): W3dsAwarenessReceiptRecord {
  return { ...record };
}

function recordFromRow(row: {
  id: string;
  globalId: string;
  createdAt: Date;
}): W3dsAwarenessReceiptRecord {
  return {
    id: row.id,
    globalId: row.globalId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** In-memory store for explicit unit tests only. */
export class InMemoryW3dsAwarenessReceiptStore implements W3dsAwarenessReceiptStore {
  private readonly records = new Map<string, W3dsAwarenessReceiptRecord>();

  async getByGlobalId(globalId: string): Promise<W3dsAwarenessReceiptRecord | undefined> {
    const found = this.records.get(globalId);
    return found ? cloneReceipt(found) : undefined;
  }

  async recordReceipt(input: RecordW3dsAwarenessReceiptInput): Promise<W3dsAwarenessReceiptRecord> {
    const existing = this.records.get(input.globalId);
    if (existing) return cloneReceipt(existing);

    const created: W3dsAwarenessReceiptRecord = {
      id: randomUUID(),
      globalId: input.globalId,
      createdAt: new Date(input.now).toISOString(),
    };
    this.records.set(input.globalId, created);
    return cloneReceipt(created);
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

  async recordReceipt(input: RecordW3dsAwarenessReceiptInput): Promise<W3dsAwarenessReceiptRecord> {
    const existing = await this.getByGlobalId(input.globalId);
    if (existing) return existing;

    const [created] = await this.db
      .insert(w3dsAwarenessReceipts)
      .values({
        id: randomUUID(),
        globalId: input.globalId,
        createdAt: new Date(input.now),
      })
      .onConflictDoNothing()
      .returning();

    if (created) return recordFromRow(created);

    const raced = await this.getByGlobalId(input.globalId);
    if (!raced) {
      throw new Error('Unable to persist the Awareness webhook receipt.');
    }
    return raced;
  }
}

export function createPostgresW3dsAwarenessReceiptStore(
  db: W3dsDatabase = getW3dsDatabase(),
): PostgresW3dsAwarenessReceiptStore {
  return new PostgresW3dsAwarenessReceiptStore(db);
}
