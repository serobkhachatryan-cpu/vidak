import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { W3dsDatabase } from './db/client';
import { playbackSourceRefreshEpochs } from './db/schema';
import {
  PostgresPlaybackSourceRefreshStore,
  playbackSourceRefreshCleanupIntervalMs,
  playbackSourceRefreshLeaseTtlMs,
  playbackSourceRefreshStateTtlMs,
} from './playback-source-refresh';
import { mintSharedVideoAuthorizationReceipt } from './shared-video-authorization-receipt';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const env = { W3DS_AUTH_JWT_SECRET: 'playback-source-refresh-test-secret-0123456789' };
const viewerEName = '@viewer.w3id';
const streamA = 'v2.opaque-stream-a_12345.signature';
const streamB = 'v2.opaque-stream-b_12345.signature';
const now = 1_750_000_000_000;
// Cross-replica handoffs deliberately require a portable source deadline.
// Keep ordinary fixtures valid long enough for the deterministic lease tests.
const mediaUrlA = signedMediaUrl('a.mp4', now + 120_000);
const mediaUrlB = signedMediaUrl('b.mp4', now + 120_000);

let databaseClient: PGlite | undefined;

afterEach(async () => {
  await databaseClient?.close();
  databaseClient = undefined;
});

function receipt(streamId = streamA, at = now): string {
  return mintSharedVideoAuthorizationReceipt({ viewerEName, streamId, env, now: at });
}

function binding(streamId = streamA, at = now) {
  return { viewerEName, streamId, now: at };
}

function signedMediaUrl(path: string, expiresAt: number): string {
  return `https://media.example.test/${path}?expires=${Math.floor(expiresAt / 1000)}&signature=source-token`;
}

async function createStorePair(): Promise<{
  database: W3dsDatabase;
  replicaA: PostgresPlaybackSourceRefreshStore;
  replicaB: PostgresPlaybackSourceRefreshStore;
}> {
  databaseClient = new PGlite();
  const migrationDb = drizzle(databaseClient);
  await migrate(migrationDb, { migrationsFolder });
  const database = migrationDb as unknown as W3dsDatabase;
  return {
    database,
    replicaA: new PostgresPlaybackSourceRefreshStore(database, { env }),
    replicaB: new PostgresPlaybackSourceRefreshStore(database, { env }),
  };
}

function acquired(
  value: Awaited<ReturnType<PostgresPlaybackSourceRefreshStore['claim']>>,
): Extract<typeof value, { kind: 'acquired' }> {
  expect(value.kind).toBe('acquired');
  if (value.kind !== 'acquired') throw new Error('Expected a source-refresh lease.');
  return value;
}

describe('playback source-refresh store', () => {
  it('serializes cross-replica claims and publishes the winning encrypted source', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const first = acquired(await replicaA.claim(binding()));

    await expect(replicaB.claim(binding())).resolves.toEqual({ kind: 'in_progress' });
    await expect(
      replicaA.publish({ ...binding(), lease: first.lease, mediaUrl: mediaUrlA }),
    ).resolves.toBe(true);

    await expect(replicaB.read({ ...binding(), receipt: receipt() })).resolves.toEqual({
      kind: 'ready',
      epoch: first.lease.epoch,
      mediaUrl: mediaUrlA,
    });
  });

  it('does not retain a ready source handoff past its explicit redirect safety deadline', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const first = acquired(await replicaA.claim(binding()));
    const sourceExpiresAt = now + 30_000;
    const shortLivedUrl = signedMediaUrl('short-lived.mp4', sourceExpiresAt);

    await expect(
      replicaA.publish({ ...binding(), lease: first.lease, mediaUrl: shortLivedUrl }),
    ).resolves.toBe(true);
    await expect(
      replicaB.read({ ...binding(streamA, now + 14_999), receipt: receipt(streamA) }),
    ).resolves.toEqual({ kind: 'ready', epoch: first.lease.epoch, mediaUrl: shortLivedUrl });
    await expect(
      replicaB.read({ ...binding(streamA, now + 15_000), receipt: receipt(streamA) }),
    ).resolves.toEqual({ kind: 'absent' });
  });

  it('refuses an opaque source without an explicit expiry as a durable handoff', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const claim = acquired(await replicaA.claim(binding()));
    const opaqueUrl = 'https://media.example.test/opaque.mp4?source-token=server-only';

    await expect(
      replicaA.publish({ ...binding(), lease: claim.lease, mediaUrl: opaqueUrl }),
    ).resolves.toBe(false);
    await expect(replicaB.read({ ...binding(), receipt: receipt() })).resolves.toEqual({
      kind: 'resolving',
      epoch: claim.lease.epoch,
    });
  });

  it('releases exactly an opaque or failed resolving lease so recovery can retry immediately', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const first = acquired(await replicaA.claim(binding()));

    await expect(replicaA.release({ ...binding(), lease: first.lease })).resolves.toBe(true);
    await expect(replicaB.read({ ...binding(), receipt: receipt() })).resolves.toEqual({
      kind: 'absent',
    });
    const second = acquired(await replicaB.claim(binding()));
    expect(second.lease.token).not.toBe(first.lease.token);
    // The deleted lease cannot affect the new row even when the epoch starts
    // over: the exact lease hash is part of every mutation predicate.
    await expect(replicaA.release({ ...binding(), lease: first.lease })).resolves.toBe(false);
  });

  it('uses the database statement clock for production lease predicates', async () => {
    const { database, replicaA } = await createStorePair();
    // Omit the test-only logical clock: production must derive lease expiry
    // and its conditional publish predicate from `clock_timestamp()` when
    // the statement actually executes.
    const claim = acquired(await replicaA.claim({ viewerEName, streamId: streamA }));
    const [row] = await database
      .select({ bindingHash: playbackSourceRefreshEpochs.bindingHash })
      .from(playbackSourceRefreshEpochs)
      .limit(1);
    expect(row?.bindingHash).toBeDefined();
    await database
      .update(playbackSourceRefreshEpochs)
      .set({
        leaseExpiresAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + playbackSourceRefreshStateTtlMs),
      })
      .where(eq(playbackSourceRefreshEpochs.bindingHash, row?.bindingHash ?? ''));

    await expect(
      replicaA.publish({ viewerEName, streamId: streamA, lease: claim.lease, mediaUrl: mediaUrlA }),
    ).resolves.toBe(false);
  });

  it('does not let a browser recovery POST replace a healthy ready source epoch', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const first = acquired(await replicaA.claim(binding()));
    await expect(
      replicaA.publish({ ...binding(), lease: first.lease, mediaUrl: mediaUrlA }),
    ).resolves.toBe(true);

    // A plain POST has the same durable claim shape as an absent/failed
    // recovery. It must not serially force-refresh the healthy source that
    // another replica recovered.
    await expect(replicaB.claim(binding())).resolves.toEqual({ kind: 'in_progress' });
    await expect(replicaB.read({ ...binding(), receipt: receipt() })).resolves.toEqual({
      kind: 'ready',
      epoch: first.lease.epoch,
      mediaUrl: mediaUrlA,
    });

    // Only a playback route that saw this exact source rejected can replace
    // it. A current epoch is an explicit CAS fence, not a user-controlled
    // "refresh everything" capability.
    const observedRejection = acquired(
      await replicaB.claim({ ...binding(), replaceReadyEpoch: first.lease.epoch }),
    );
    expect(observedRejection.lease.epoch).toBe(first.lease.epoch + 1);
  });

  it('conditionally replaces only the exact rejected ready epoch', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const first = acquired(await replicaA.claim(binding()));
    await expect(
      replicaA.publish({ ...binding(), lease: first.lease, mediaUrl: mediaUrlA }),
    ).resolves.toBe(true);

    const replacement = acquired(
      await replicaB.claim({
        ...binding(),
        replaceReadyEpoch: first.lease.epoch,
      }),
    );
    expect(replacement.lease.epoch).toBe(first.lease.epoch + 1);
    await expect(
      replicaB.publish({ ...binding(), lease: replacement.lease, mediaUrl: mediaUrlB }),
    ).resolves.toBe(true);

    // A late stale request still carrying the first epoch cannot overwrite B's
    // ready replacement. Its caller must reread the durable handoff instead.
    await expect(
      replicaA.claim({
        ...binding(),
        replaceReadyEpoch: first.lease.epoch,
      }),
    ).resolves.toEqual({ kind: 'in_progress' });
    await expect(replicaA.read({ ...binding(), receipt: receipt() })).resolves.toEqual({
      kind: 'ready',
      epoch: replacement.lease.epoch,
      mediaUrl: mediaUrlB,
    });
  });

  it('rejects stale publish and failure attempts after another replica takes over', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const first = acquired(await replicaA.claim(binding()));
    const takeoverNow = now + playbackSourceRefreshLeaseTtlMs + 1;
    const second = acquired(await replicaB.claim(binding(streamA, takeoverNow)));

    expect(second.lease.epoch).toBe(first.lease.epoch + 1);
    await expect(
      replicaA.publish({
        ...binding(streamA, takeoverNow),
        lease: first.lease,
        mediaUrl: mediaUrlA,
      }),
    ).resolves.toBe(false);
    await expect(
      replicaA.fail({ ...binding(streamA, takeoverNow), lease: first.lease }),
    ).resolves.toBe(false);
    await expect(
      replicaB.publish({
        ...binding(streamA, takeoverNow),
        lease: second.lease,
        mediaUrl: mediaUrlB,
      }),
    ).resolves.toBe(true);

    await expect(
      replicaA.read({
        ...binding(streamA, takeoverNow),
        receipt: receipt(streamA, takeoverNow),
      }),
    ).resolves.toEqual({ kind: 'ready', epoch: second.lease.epoch, mediaUrl: mediaUrlB });
  });

  it('exposes an expired resolving lease as retryable and lets another replica take over', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const first = acquired(await replicaA.claim(binding()));
    const afterLease = now + playbackSourceRefreshLeaseTtlMs + 1;

    await expect(
      replicaB.read({ ...binding(streamA, afterLease), receipt: receipt(streamA) }),
    ).resolves.toEqual({ kind: 'retryable', epoch: first.lease.epoch });

    const next = acquired(await replicaB.claim(binding(streamA, afterLease)));
    expect(next.lease.epoch).toBe(first.lease.epoch + 1);
  });

  it('requires the exact still-valid receipt, viewer, and stream for every durable read', async () => {
    const { replicaA, replicaB } = await createStorePair();
    const claim = acquired(await replicaA.claim(binding()));
    await replicaA.publish({ ...binding(), lease: claim.lease, mediaUrl: mediaUrlA });
    const receiptValue = receipt();

    await expect(replicaB.read({ ...binding(), receipt: `${receiptValue}x` })).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(
      replicaB.read({ ...binding(), viewerEName: '@another-viewer.w3id', receipt: receiptValue }),
    ).resolves.toEqual({ kind: 'unavailable' });
    await expect(replicaB.read({ ...binding(streamB), receipt: receiptValue })).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(replicaB.read({ ...binding(), receipt: receiptValue })).resolves.toEqual({
      kind: 'ready',
      epoch: claim.lease.epoch,
      mediaUrl: mediaUrlA,
    });
  });

  it('surfaces a durable storage read failure instead of misrepresenting it as a source fence', async () => {
    const unavailableDatabase = {
      select: vi.fn(() => {
        throw new Error('playback source refresh storage unavailable');
      }),
    } as unknown as W3dsDatabase;
    const store = new PostgresPlaybackSourceRefreshStore(unavailableDatabase, { env });

    await expect(store.read({ ...binding(), receipt: receipt() })).rejects.toThrow(
      'playback source refresh storage unavailable',
    );
  });

  it('rejects a ciphertext transplanted to another viewer-stream binding', async () => {
    const { database, replicaA, replicaB } = await createStorePair();
    const first = acquired(await replicaA.claim(binding(streamA)));
    await replicaA.publish({ ...binding(streamA), lease: first.lease, mediaUrl: mediaUrlA });
    const [firstRow] = await database.select().from(playbackSourceRefreshEpochs);
    expect(firstRow?.encryptedPayload).toBeDefined();

    const second = acquired(await replicaA.claim(binding(streamB)));
    await replicaA.publish({ ...binding(streamB), lease: second.lease, mediaUrl: mediaUrlB });
    const rows = await database.select().from(playbackSourceRefreshEpochs);
    const secondRow = rows.find((row) => row.bindingHash !== firstRow?.bindingHash);
    expect(secondRow).toBeDefined();
    await database
      .update(playbackSourceRefreshEpochs)
      .set({ encryptedPayload: firstRow?.encryptedPayload ?? null })
      .where(eq(playbackSourceRefreshEpochs.bindingHash, secondRow?.bindingHash ?? ''));

    await expect(
      replicaB.read({ ...binding(streamB), receipt: receipt(streamB) }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('persists only keyed hashes and encrypted source material', async () => {
    const { database, replicaA } = await createStorePair();
    const claim = acquired(await replicaA.claim(binding()));
    await replicaA.publish({ ...binding(), lease: claim.lease, mediaUrl: mediaUrlA });

    const rows = await database.select().from(playbackSourceRefreshEpochs);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(Object.keys(row ?? {})).not.toEqual(
      expect.arrayContaining(['viewerEName', 'streamId', 'receipt', 'mediaUrl']),
    );
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(viewerEName);
    expect(serialized).not.toContain(streamA);
    expect(serialized).not.toContain(mediaUrlA);
    expect(serialized).not.toContain(claim.lease.token);
    expect(row?.bindingHash).not.toBe(streamA);
    expect(row?.leaseHash).toBeNull();
    expect(row?.encryptedPayload).not.toContain(mediaUrlA);
  });

  it('opportunistically removes a bounded expired batch without deleting a fresh row', async () => {
    const { database, replicaA, replicaB } = await createStorePair();
    await replicaA.claim(binding(streamA));
    const cleanupNow = now + playbackSourceRefreshStateTtlMs + 1;
    await replicaB.claim(binding(streamB, cleanupNow));

    await vi.waitFor(async () => {
      const rows = await database.select().from(playbackSourceRefreshEpochs);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(cleanupNow);
      expect(rows[0]?.status).toBe('resolving');
    });
  });

  it('coalesces process-local expiry cleanup across rapid successful transitions', async () => {
    const { database, replicaA, replicaB } = await createStorePair();
    const execute = vi.spyOn(database, 'execute');

    await replicaA.claim(binding(streamA));
    await replicaB.claim(binding(streamB));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    await replicaA.claim(binding('v2.opaque-stream-c_12345.signature', now + 1));
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    await replicaA.claim(
      binding('v2.opaque-stream-d_12345.signature', now + playbackSourceRefreshCleanupIntervalMs),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  });
});
