import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { W3dsDatabase } from './db/client';
import {
  claimRecordingConcatTicket,
  InMemoryRecordingConcatTicketStore,
  issueRecordingConcatTicket,
  PostgresRecordingConcatTicketStore,
  parseRecordingStreamIds,
  RecordingConcatTicketError,
  readRecordingConcatSegment,
  recordingConcatTicketActiveLeaseMs,
  renewRecordingConcatTicketLease,
  replaceRecordingConcatSegment,
  resolveInternalMediaOrigin,
} from './recording-concat-ticket';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const viewer = { eName: '@viewer.w3id', eVaultUri: 'https://vault.example' };
const loopbackOrigin = 'http://127.0.0.1:3910';

let store: InMemoryRecordingConcatTicketStore;
let databaseClient: PGlite | undefined;

beforeEach(() => {
  store = new InMemoryRecordingConcatTicketStore();
});

afterEach(async () => {
  await databaseClient?.close();
  databaseClient = undefined;
});

describe('recording concat tickets', () => {
  it('keeps the inner capability server-only and binds it to the claimed viewer', async () => {
    const correlationId = 'recording-correlation-1';
    const issued = await issueRecordingConcatTicket(
      viewer,
      ['stream-one', 'stream-two'],
      1_000,
      correlationId,
      store,
    );
    expect(issued.playbackPath).toMatch(/^\/api\/evault\/recordings\/[A-Za-z0-9_-]{43}$/);
    expect(issued.playbackPath).not.toContain('stream-one');
    await expect(
      readRecordingConcatSegment(issued.ticket, null, '0', 1_001, store),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);

    const claimed = await claimRecordingConcatTicket(
      issued.ticket,
      viewer,
      loopbackOrigin,
      1_001,
      store,
    );
    const firstSource = new URL(claimed.sourceUrls[0] ?? '');
    const key = firstSource.searchParams.get('key');
    expect(firstSource.origin).toBe(loopbackOrigin);
    expect(firstSource.pathname).toContain(`/recordings/${issued.ticket}/segments/0`);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claimed.correlationId).toBe(correlationId);
    expect(issued.playbackPath).not.toContain(correlationId);
    expect(firstSource.toString()).not.toContain(correlationId);
    await expect(
      readRecordingConcatSegment(issued.ticket, key, '0', 1_002, store),
    ).resolves.toEqual({
      viewer,
      streamId: 'stream-one',
      correlationId,
    });
    await expect(
      readRecordingConcatSegment(issued.ticket, 'wrong', '0', 1_002, store),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);
    await expect(
      claimRecordingConcatTicket(
        issued.ticket,
        { eName: '@another.w3id' },
        loopbackOrigin,
        1_002,
        store,
      ),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);
    await expect(
      claimRecordingConcatTicket(issued.ticket, viewer, loopbackOrigin, 1_002, store),
    ).rejects.toThrow('already opening');

    await claimed.release();
    await expect(
      readRecordingConcatSegment(issued.ticket, key, '0', 1_003, store),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);
  });

  it('expires an unopened ticket quickly but keeps a claimed recording available', async () => {
    const unopened = await issueRecordingConcatTicket(viewer, ['one', 'two'], 0, undefined, store);
    await expect(
      claimRecordingConcatTicket(unopened.ticket, viewer, loopbackOrigin, 120_001, store),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);

    const opened = await issueRecordingConcatTicket(viewer, ['one', 'two'], 0, undefined, store);
    const claimed = await claimRecordingConcatTicket(
      opened.ticket,
      viewer,
      loopbackOrigin,
      1,
      store,
    );
    const key = new URL(claimed.sourceUrls[0] ?? '').searchParams.get('key');
    // The live ffmpeg route renews this short recovery lease periodically;
    // the durable playback lifetime itself remains eight hours.
    await renewRecordingConcatTicketLease(opened.ticket, store, 7 * 60 * 60_000 - 1);
    await expect(
      readRecordingConcatSegment(opened.ticket, key, '1', 7 * 60 * 60_000, store),
    ).resolves.toEqual({
      viewer,
      streamId: 'two',
      correlationId: expect.any(String),
    });
    await expect(
      readRecordingConcatSegment(opened.ticket, key, '1', 8 * 60 * 60_000 + 2, store),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);
  });

  it('does not consume a ticket when the configured internal origin is unsafe', async () => {
    const issued = await issueRecordingConcatTicket(viewer, ['one', 'two'], 0, undefined, store);
    await expect(
      claimRecordingConcatTicket(issued.ticket, viewer, 'http://localhost:3910', 1, store),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);

    const claimed = await claimRecordingConcatTicket(
      issued.ticket,
      viewer,
      loopbackOrigin,
      2,
      store,
    );
    expect(claimed.sourceUrls).toHaveLength(2);
  });

  it('accepts literal IPv6 loopback but rejects ambiguous or decorated internal origins', () => {
    expect(resolveInternalMediaOrigin({ INTERNAL_MEDIA_ORIGIN: 'http://[::1]:3910' })).toBe(
      'http://[::1]:3910',
    );
    for (const value of [
      'http://localhost:3910',
      'https://127.0.0.1:3910',
      'http://user:pass@127.0.0.1:3910',
      'http://127.0.0.1:3910/prefix',
      'http://127.0.0.1:3910?query',
    ]) {
      expect(() => resolveInternalMediaOrigin({ INTERNAL_MEDIA_ORIGIN: value })).toThrow(
        RecordingConcatTicketError,
      );
    }
  });

  it('rejects malformed, duplicate, or excessive source lists', () => {
    expect(() => parseRecordingStreamIds(['only-one'])).toThrow(RecordingConcatTicketError);
    expect(() => parseRecordingStreamIds(['same', 'same'])).toThrow(RecordingConcatTicketError);
    expect(() =>
      parseRecordingStreamIds(Array.from({ length: 513 }, (_, index) => `stream-${index}`)),
    ).toThrow(RecordingConcatTicketError);
    expect(() => parseRecordingStreamIds(['one', ' '])).toThrow(RecordingConcatTicketError);
  });

  it('can replace an expired grant without changing the browser-visible ticket', async () => {
    const issued = await issueRecordingConcatTicket(
      viewer,
      ['old-one', 'old-two'],
      0,
      undefined,
      store,
    );
    const claimed = await claimRecordingConcatTicket(
      issued.ticket,
      viewer,
      loopbackOrigin,
      1,
      store,
    );
    const key = new URL(claimed.sourceUrls[1] ?? '').searchParams.get('key');
    await replaceRecordingConcatSegment(issued.ticket, key, '1', 'renewed-two', 2, store);
    await expect(readRecordingConcatSegment(issued.ticket, key, '1', 3, store)).resolves.toEqual({
      viewer,
      streamId: 'renewed-two',
      correlationId: expect.any(String),
    });
  });

  it('drops the initial authorization receipt when segment zero is renewed', async () => {
    const initialAuthorizationReceipt = 'svr1.receipt-bound-to-original-first-stream.signature';
    const issued = await issueRecordingConcatTicket(
      viewer,
      ['old-first', 'second'],
      0,
      undefined,
      store,
      { initialAuthorizationReceipt },
    );
    const claimed = await claimRecordingConcatTicket(
      issued.ticket,
      viewer,
      loopbackOrigin,
      1,
      store,
    );
    const key = new URL(claimed.sourceUrls[0] ?? '').searchParams.get('key');

    await expect(
      readRecordingConcatSegment(issued.ticket, key, '0', 2, store),
    ).resolves.toMatchObject({
      streamId: 'old-first',
      initialAuthorizationReceipt,
    });
    // Refreshing a later segment leaves source zero and its receipt intact.
    await replaceRecordingConcatSegment(issued.ticket, key, '1', 'renewed-second', 3, store);
    await expect(
      readRecordingConcatSegment(issued.ticket, key, '0', 4, store),
    ).resolves.toMatchObject({
      streamId: 'old-first',
      initialAuthorizationReceipt,
    });

    await replaceRecordingConcatSegment(issued.ticket, key, '0', 'renewed-first', 5, store);
    await expect(readRecordingConcatSegment(issued.ticket, key, '0', 6, store)).resolves.toEqual({
      viewer,
      streamId: 'renewed-first',
      correlationId: expect.any(String),
    });
  });

  it('renews a live lease without shortening the playback lifetime', async () => {
    const issued = await issueRecordingConcatTicket(viewer, ['one', 'two'], 0, undefined, store);
    const claimed = await claimRecordingConcatTicket(
      issued.ticket,
      viewer,
      loopbackOrigin,
      1,
      store,
    );
    const key = new URL(claimed.sourceUrls[0] ?? '').searchParams.get('key');

    await expect(
      renewRecordingConcatTicketLease(issued.ticket, store, recordingConcatTicketActiveLeaseMs - 1),
    ).resolves.toBe(true);
    await expect(
      readRecordingConcatSegment(
        issued.ticket,
        key,
        '0',
        recordingConcatTicketActiveLeaseMs + 1,
        store,
      ),
    ).resolves.toMatchObject({ streamId: 'one' });
    await expect(
      readRecordingConcatSegment(
        issued.ticket,
        key,
        '0',
        2 * recordingConcatTicketActiveLeaseMs,
        store,
      ),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);
  });

  it('shares encrypted, viewer-bound tickets across separate PostgreSQL store instances', async () => {
    databaseClient = new PGlite();
    const database = drizzle(databaseClient) as unknown as W3dsDatabase;
    await migrate(database, { migrationsFolder });
    const encryptionKey = Buffer.alloc(32, 7);
    const issuingReplica = new PostgresRecordingConcatTicketStore(database, encryptionKey);
    const playbackReplica = new PostgresRecordingConcatTicketStore(database, encryptionKey);
    const initialAuthorizationReceipt = 'svr1.opaque-initial-receipt.signature';

    const issued = await issueRecordingConcatTicket(
      viewer,
      ['sealed-stream-one', 'sealed-stream-two'],
      1_000,
      'recording-correlation-2',
      issuingReplica,
      { initialAuthorizationReceipt },
    );
    const raw = await databaseClient.query<{ encrypted_payload: string }>(
      'select encrypted_payload from recording_concat_tickets where id = $1',
      [issued.ticket],
    );
    expect(raw.rows[0]?.encrypted_payload).toContain('v1.');
    expect(raw.rows[0]?.encrypted_payload).not.toContain('sealed-stream-one');
    expect(raw.rows[0]?.encrypted_payload).not.toContain('recording-correlation-2');
    expect(raw.rows[0]?.encrypted_payload).not.toContain(initialAuthorizationReceipt);

    const claimed = await claimRecordingConcatTicket(
      issued.ticket,
      { eName: '@VIEWER.W3ID' },
      loopbackOrigin,
      1_001,
      playbackReplica,
    );
    const key = new URL(claimed.sourceUrls[0] ?? '').searchParams.get('key');
    expect(issued.playbackPath).not.toContain(initialAuthorizationReceipt);
    expect(claimed.sourceUrls.join('\n')).not.toContain(initialAuthorizationReceipt);
    await expect(
      readRecordingConcatSegment(issued.ticket, key, '0', 1_002, issuingReplica),
    ).resolves.toEqual({
      viewer,
      streamId: 'sealed-stream-one',
      correlationId: 'recording-correlation-2',
      initialAuthorizationReceipt,
    });
    await expect(
      readRecordingConcatSegment(issued.ticket, key, '1', 1_002, issuingReplica),
    ).resolves.toEqual({
      viewer,
      streamId: 'sealed-stream-two',
      correlationId: 'recording-correlation-2',
    });
    await expect(
      claimRecordingConcatTicket(issued.ticket, viewer, loopbackOrigin, 1_003, issuingReplica),
    ).rejects.toThrow('already opening');

    await claimed.release();
    await expect(
      readRecordingConcatSegment(issued.ticket, key, '0', 1_004, playbackReplica),
    ).rejects.toBeInstanceOf(RecordingConcatTicketError);
  });

  it('recovers admission slots after a crashed replica lease expires', async () => {
    databaseClient = new PGlite();
    const database = drizzle(databaseClient) as unknown as W3dsDatabase;
    await migrate(database, { migrationsFolder });
    const encryptionKey = Buffer.alloc(32, 8);
    const issuingReplica = new PostgresRecordingConcatTicketStore(database, encryptionKey);
    const playbackReplica = new PostgresRecordingConcatTicketStore(database, encryptionKey);

    for (let index = 0; index < 4; index += 1) {
      const issued = await issueRecordingConcatTicket(
        viewer,
        [`source-${index}-one`, `source-${index}-two`],
        0,
        undefined,
        issuingReplica,
      );
      await claimRecordingConcatTicket(issued.ticket, viewer, loopbackOrigin, 1, playbackReplica);
    }

    // No release simulates the owning pod disappearing. The next issuer holds
    // the global DB admission lock, prunes expired active leases, and can open
    // another recording rather than waiting eight hours for `expires_at`.
    await expect(
      issueRecordingConcatTicket(
        viewer,
        ['source-recovered-one', 'source-recovered-two'],
        recordingConcatTicketActiveLeaseMs + 2,
        undefined,
        issuingReplica,
      ),
    ).resolves.toMatchObject({ playbackPath: expect.stringContaining('/api/evault/recordings/') });
  });
});
