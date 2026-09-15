import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { W3dsDatabase } from './db/client';
import { eVaultMediaUrlCache } from './db/schema';
import {
  EVaultMediaUrlCacheConfigurationError,
  InMemoryEVaultMediaUrlCache,
  maxEVaultMediaUrlCacheTtlMs,
  PostgresEVaultMediaUrlCache,
} from './evault-media-url-cache';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const env = { W3DS_AUTH_JWT_SECRET: 'evault-media-url-cache-test-secret-0123456789' };
const cacheKey =
  '@viewer.w3id\u0000w3ds://file?id=@owner.w3id/recording\u0000shared\u0000@owner.w3id\u0000chat-1';
const now = 1_750_000_000_000;
const mediaUrl = signedMediaUrl('video.mp4', now + maxEVaultMediaUrlCacheTtlMs + 60_000);

let databaseClient: PGlite | undefined;

afterEach(async () => {
  await databaseClient?.close();
  databaseClient = undefined;
});

function binding(key = cacheKey, at = now) {
  return { cacheKey: key, now: at };
}

function signedMediaUrl(path: string, expiresAt: number): string {
  return `https://media.example.test/${path}?expires=${Math.floor(expiresAt / 1000)}&signature=source-token`;
}

async function createPgliteCaches(): Promise<{
  database: W3dsDatabase;
  writer: PostgresEVaultMediaUrlCache;
  reader: PostgresEVaultMediaUrlCache;
}> {
  databaseClient = new PGlite();
  const migrationDb = drizzle(databaseClient);
  await migrate(migrationDb, { migrationsFolder });
  const database = migrationDb as unknown as W3dsDatabase;
  return {
    database,
    writer: new PostgresEVaultMediaUrlCache(database, { env }),
    reader: new PostgresEVaultMediaUrlCache(database, { env }),
  };
}

describe('eVault media URL cache', () => {
  it('reuses only an encrypted canonical eVault redirect across server instances', async () => {
    const { database, writer, reader } = await createPgliteCaches();
    const reservation = await writer.get(binding());
    expect(reservation?.mediaUrl).toBeUndefined();
    expect(reservation?.writeToken).toEqual(expect.any(String));

    await expect(
      writer.put({ ...binding(), mediaUrl, writeToken: reservation?.writeToken ?? '' }),
    ).resolves.toBe(true);
    await expect(reader.get(binding())).resolves.toMatchObject({ mediaUrl });

    const rows = await database.select().from(eVaultMediaUrlCache);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(Object.keys(row ?? {})).toEqual(
      expect.arrayContaining([
        'bindingHash',
        'generation',
        'encryptedPayload',
        'mediaExpiresAt',
        'expiresAt',
        'createdAt',
        'updatedAt',
      ]),
    );
    expect(Object.keys(row ?? {})).not.toEqual(
      expect.arrayContaining(['cacheKey', 'viewerEName', 'streamId', 'mediaUrl']),
    );
    expect(row?.bindingHash).not.toBe(cacheKey);
    expect(row?.encryptedPayload).not.toContain(cacheKey);
    expect(row?.encryptedPayload).not.toContain(mediaUrl);
  });

  it('requires the exact server-side viewer/source context and expires URLs', async () => {
    const cache = new InMemoryEVaultMediaUrlCache({ env });
    const reservation = await cache.get(binding());
    await expect(
      cache.put({
        ...binding(),
        mediaUrl,
        ttlMs: 10,
        writeToken: reservation?.writeToken ?? '',
      }),
    ).resolves.toBe(true);
    expect((await cache.get(binding(`${cacheKey}\u0000different-chat`)))?.mediaUrl).toBeUndefined();
    await expect(cache.get(binding(cacheKey, now + 9))).resolves.toMatchObject({ mediaUrl });
    expect((await cache.get(binding(cacheKey, now + 10)))?.mediaUrl).toBeUndefined();
  });

  it('clamps an explicit source lifetime and never persists an opaque redirect', async () => {
    const cache = new InMemoryEVaultMediaUrlCache({ env });
    const reservation = await cache.get(binding());
    await expect(
      cache.put({
        ...binding(),
        mediaUrl,
        ttlMs: maxEVaultMediaUrlCacheTtlMs * 2,
        writeToken: reservation?.writeToken ?? '',
      }),
    ).resolves.toBe(true);
    await expect(
      cache.get(binding(cacheKey, now + maxEVaultMediaUrlCacheTtlMs - 1)),
    ).resolves.toMatchObject({
      mediaUrl,
    });
    expect(
      (await cache.get(binding(cacheKey, now + maxEVaultMediaUrlCacheTtlMs)))?.mediaUrl,
    ).toBeUndefined();

    const opaqueReservation = await cache.get(binding('opaque-source'));
    await expect(
      cache.put({
        ...binding('opaque-source'),
        mediaUrl: 'https://media.example.test/video.mp4?signature=opaque-source-token',
        writeToken: opaqueReservation?.writeToken ?? '',
      }),
    ).resolves.toBe(false);
  });

  it('expires before an explicitly signed source URL and fences an old writer after invalidation', async () => {
    const { writer, reader } = await createPgliteCaches();
    const shortLivedUrl = signedMediaUrl('short-lived.mp4', now + 60_000);
    const oldReservation = await writer.get(binding());
    await expect(
      writer.put({
        ...binding(),
        mediaUrl: shortLivedUrl,
        writeToken: oldReservation?.writeToken ?? '',
      }),
    ).resolves.toBe(true);
    await expect(reader.get(binding(cacheKey, now + 44_999))).resolves.toMatchObject({
      mediaUrl: shortLivedUrl,
    });
    expect((await reader.get(binding(cacheKey, now + 45_000)))?.mediaUrl).toBeUndefined();

    const staleReservation = await writer.get(binding('stale-writer'));
    const replacement = await reader.invalidate(binding('stale-writer'));
    await expect(
      writer.put({
        ...binding('stale-writer'),
        mediaUrl,
        writeToken: staleReservation?.writeToken ?? '',
      }),
    ).resolves.toBe(false);
    const fenced = await reader.get(binding('stale-writer'));
    expect(fenced?.writeToken).toBe(replacement?.writeToken);
    expect(fenced?.mediaUrl).toBeUndefined();
  });

  it('rejects unsafe URLs or malformed bindings', async () => {
    const cache = new InMemoryEVaultMediaUrlCache({ env });
    const reservation = await cache.get(binding());
    await expect(
      cache.put({ ...binding(''), mediaUrl, writeToken: reservation?.writeToken ?? '' }),
    ).resolves.toBe(false);
    await expect(
      cache.put({
        ...binding(),
        mediaUrl: 'http://media.example.test/not-https.mp4',
        writeToken: reservation?.writeToken ?? '',
      }),
    ).resolves.toBe(false);
  });

  it('requires the deployment W3DS secret', () => {
    expect(() => new InMemoryEVaultMediaUrlCache({ env: {} })).toThrow(
      EVaultMediaUrlCacheConfigurationError,
    );
  });
});
