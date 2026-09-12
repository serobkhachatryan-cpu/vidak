import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { W3dsDatabase } from './db/client';
import { playbackResolutionCache } from './db/schema';
import {
  deletePlaybackResolutionCache,
  getPlaybackResolutionCache,
  InMemoryPlaybackResolutionCache,
  maxPlaybackResolutionCacheTtlMs,
  PostgresPlaybackResolutionCache,
  putPlaybackResolutionCache,
  resolvePlaybackResolutionCacheEncryptionKey,
  setPlaybackResolutionCacheForTests,
} from './playback-resolution-cache';
import { mintSharedVideoAuthorizationReceipt } from './shared-video-authorization-receipt';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const env = { W3DS_AUTH_JWT_SECRET: 'playback-resolution-cache-test-secret-0123456789' };
const viewerEName = '@viewer.w3id';
const streamId = 'v2.opaque-stream-id_12345.signature';
const mediaUrl = 'https://media.example.test/video.mp4?signature=source-token';
const now = 1_750_000_000_000;

let databaseClient: PGlite | undefined;

afterEach(async () => {
  setPlaybackResolutionCacheForTests();
  await databaseClient?.close();
  databaseClient = undefined;
});

function receipt(at = now): string {
  return mintSharedVideoAuthorizationReceipt({ viewerEName, streamId, env, now: at });
}

function binding(receiptValue = receipt(), at = now) {
  return { receipt: receiptValue, viewerEName, streamId, now: at };
}

async function createPgliteCache(): Promise<{
  database: W3dsDatabase;
  writer: PostgresPlaybackResolutionCache;
  reader: PostgresPlaybackResolutionCache;
}> {
  databaseClient = new PGlite();
  const migrationDb = drizzle(databaseClient);
  await migrate(migrationDb, { migrationsFolder });
  const database = migrationDb as unknown as W3dsDatabase;
  return {
    database,
    writer: new PostgresPlaybackResolutionCache(database, { env }),
    reader: new PostgresPlaybackResolutionCache(database, { env }),
  };
}

describe('playback-resolution cache', () => {
  it('reuses only an encrypted, receipt-bound source across PostgreSQL replicas', async () => {
    const { database, writer, reader } = await createPgliteCache();
    const receiptValue = receipt();

    await expect(writer.put({ ...binding(receiptValue), mediaUrl })).resolves.toBe(true);
    await expect(reader.get(binding(receiptValue))).resolves.toBe(mediaUrl);

    const rows = await database.select().from(playbackResolutionCache);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).toEqual(
      expect.arrayContaining([
        'receiptHash',
        'encryptedPayload',
        'expiresAt',
        'createdAt',
        'updatedAt',
      ]),
    );
    expect(Object.keys(row ?? {})).not.toEqual(
      expect.arrayContaining(['viewerEName', 'streamId', 'receipt', 'mediaUrl']),
    );
    expect(row?.receiptHash).not.toBe(receiptValue);
    expect(row?.encryptedPayload).not.toContain(mediaUrl);
    expect(row?.encryptedPayload).not.toContain(viewerEName);
    expect(row?.encryptedPayload).not.toContain(streamId);
  });

  it('requires the exact receipt, viewer, and stream every time', async () => {
    const { writer, reader } = await createPgliteCache();
    const receiptValue = receipt();
    await writer.put({ ...binding(receiptValue), mediaUrl });

    await expect(
      reader.get({ ...binding(receiptValue), viewerEName: '@different-viewer.w3id' }),
    ).resolves.toBeUndefined();
    await expect(
      reader.get({ ...binding(receiptValue), streamId: 'v2.different-stream.signature' }),
    ).resolves.toBeUndefined();
    await expect(reader.get({ ...binding(`${receiptValue}x`) })).resolves.toBeUndefined();
    await expect(
      reader.delete({ ...binding(receiptValue), viewerEName: '@different-viewer.w3id' }),
    ).resolves.toBe(false);
    await expect(reader.get(binding(receiptValue))).resolves.toBe(mediaUrl);
    await expect(reader.delete(binding(receiptValue))).resolves.toBe(true);
    await expect(reader.get(binding(receiptValue))).resolves.toBeUndefined();
  });

  it('enforces the 45-second upper bound and cleans expired rows on the next write', async () => {
    const { database, writer, reader } = await createPgliteCache();
    const firstReceipt = receipt();
    await expect(
      writer.put({
        ...binding(firstReceipt),
        mediaUrl,
        ttlMs: maxPlaybackResolutionCacheTtlMs * 3,
      }),
    ).resolves.toBe(true);
    const [firstRow] = await database.select().from(playbackResolutionCache);
    expect(firstRow?.expiresAt.getTime()).toBe(now + maxPlaybackResolutionCacheTtlMs);
    await expect(
      reader.get(binding(firstReceipt, now + maxPlaybackResolutionCacheTtlMs - 1)),
    ).resolves.toBe(mediaUrl);

    const nextNow = now + maxPlaybackResolutionCacheTtlMs;
    const nextReceipt = receipt(nextNow);
    await expect(
      writer.put({
        ...binding(nextReceipt, nextNow),
        mediaUrl: 'https://media.example.test/replacement.mp4?signature=second-token',
      }),
    ).resolves.toBe(true);
    const rows = await database.select().from(playbackResolutionCache);
    expect(rows).toHaveLength(1);
    await expect(reader.get(binding(firstReceipt, nextNow))).resolves.toBeUndefined();
  });

  it('declines unsafe URL shapes and never turns them into cache entries', async () => {
    const cache = new InMemoryPlaybackResolutionCache({ env });
    for (const unsafeUrl of [
      'http://media.example.test/video.mp4',
      'https://127.0.0.1/video.mp4',
      'https://user:password@media.example.test/video.mp4',
      'https://media.example.test/video.mp4#fragment',
    ]) {
      await expect(cache.put({ ...binding(), mediaUrl: unsafeUrl })).resolves.toBe(false);
    }
    await expect(cache.get(binding())).resolves.toBeUndefined();
  });

  it('keeps the same validation and expiry behavior in its test-only in-memory implementation', async () => {
    const cache = new InMemoryPlaybackResolutionCache({ env });
    const receiptValue = receipt();
    await expect(cache.put({ ...binding(receiptValue), mediaUrl, ttlMs: 10 })).resolves.toBe(true);
    await expect(cache.get(binding(receiptValue, now + 9))).resolves.toBe(mediaUrl);
    await expect(cache.get(binding(receiptValue, now + 10))).resolves.toBeUndefined();
    await expect(
      cache.put({
        ...binding(receiptValue),
        viewerEName: '@wrong-viewer.w3id',
        mediaUrl,
      }),
    ).resolves.toBe(false);
  });

  it('supports only explicit test injection and requires an adequate W3DS secret', async () => {
    expect(() => resolvePlaybackResolutionCacheEncryptionKey({})).toThrow(/W3DS_AUTH_JWT_SECRET/);
    expect(
      () => new InMemoryPlaybackResolutionCache({ env: { W3DS_AUTH_JWT_SECRET: 'short' } }),
    ).toThrow(/W3DS_AUTH_JWT_SECRET/);

    const cache = new InMemoryPlaybackResolutionCache({ env });
    setPlaybackResolutionCacheForTests(cache);
    const receiptValue = receipt();
    await expect(putPlaybackResolutionCache({ ...binding(receiptValue), mediaUrl })).resolves.toBe(
      true,
    );
    await expect(getPlaybackResolutionCache(binding(receiptValue))).resolves.toBe(mediaUrl);
    await expect(deletePlaybackResolutionCache(binding(receiptValue))).resolves.toBe(true);
  });
});
