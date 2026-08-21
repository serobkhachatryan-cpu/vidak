import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { W3dsDatabase } from './db/client';
import { PostgresW3dsAwarenessReceiptStore } from './w3ds-awareness-receipts';

vi.mock('server-only', () => ({}));

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

describe('durable Awareness receipt payload fingerprints', () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('updates the same receipt only when a verified payload digest changes', async () => {
    client = new PGlite();
    const migrationDb = drizzle(client);
    await migrate(migrationDb, { migrationsFolder });
    const receipts = new PostgresW3dsAwarenessReceiptStore(migrationDb as unknown as W3dsDatabase);

    const first = await receipts.recordReceipt({
      globalId: 'meta-envelope-1',
      payloadHash: 'a'.repeat(64),
      now: Date.parse('2026-08-22T00:00:00.000Z'),
    });
    const replay = await receipts.recordReceipt({
      globalId: 'meta-envelope-1',
      payloadHash: 'a'.repeat(64),
      now: Date.parse('2026-08-22T00:01:00.000Z'),
    });
    const changed = await receipts.recordReceipt({
      globalId: 'meta-envelope-1',
      payloadHash: 'b'.repeat(64),
      now: Date.parse('2026-08-22T00:02:00.000Z'),
    });

    expect(first.outcome).toBe('changed');
    expect(replay).toMatchObject({ outcome: 'duplicate', receipt: { id: first.receipt.id } });
    expect(changed).toMatchObject({
      outcome: 'changed',
      receipt: { id: first.receipt.id, payloadHash: 'b'.repeat(64) },
    });

    const count = await client.query<{ count: string }>(
      'select count(*)::text as count from w3ds_awareness_receipts',
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
  });
});
