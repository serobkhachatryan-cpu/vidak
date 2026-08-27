import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptChannelImportCredential } from './channel-import-crypto';
import { ChannelImportSyncService } from './channel-import-sync';
import type { W3dsDatabase } from './db/client';
import {
  channelImportConnections,
  channelImportSyncJobs,
  importedChannels,
  importedChannelVideos,
  w3dsPlatformUsers,
} from './db/schema';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const now = new Date('2026-08-27T12:00:00.000Z');
const env = {
  APP_ORIGIN: 'https://vidak.postplatforms.com',
  CHANNEL_IMPORT_STATE_SECRET: 's'.repeat(32),
  CHANNEL_IMPORT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  YOUTUBE_OAUTH_CLIENT_ID: 'youtube-client',
  YOUTUBE_OAUTH_CLIENT_SECRET: 'youtube-secret',
};

describe('channel import sync', () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('catalogues an authorised public YouTube video without copying provider media', async () => {
    client = new PGlite();
    const db = drizzle(client) as unknown as W3dsDatabase;
    await migrate(db, { migrationsFolder });
    const key = Buffer.alloc(32, 7);
    await db.insert(w3dsPlatformUsers).values({
      id: 'user-1',
      eName: 'creator.w3id',
      eVaultId: 'vault-1',
      displayName: 'Creator',
      roles: [],
      capabilities: [],
      permissions: {
        canUpload: true,
        canComment: true,
        canManageOwnChannels: true,
        canModerate: false,
        canAccessAdmin: false,
      },
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(channelImportConnections).values({
      id: 'connection-1',
      ownerId: 'user-1',
      provider: 'youtube',
      providerAccountId: 'source-channel',
      accountLabel: 'Creator source',
      encryptedAccessToken: encryptChannelImportCredential('provider-access-token', key),
      grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(importedChannels).values({
      id: 'import-1',
      connectionId: 'connection-1',
      sourceChannelId: 'source-channel',
      sourceCatalogueId: 'uploads-playlist',
      title: 'Creator source',
      sourceUrl: 'https://www.youtube.com/channel/source-channel',
      status: 'syncing',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(channelImportSyncJobs).values({
      id: 'job-1',
      importedChannelId: 'import-1',
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              contentDetails: { videoId: 'source-video', videoPublishedAt: '2026-08-01T10:00:00Z' },
              snippet: {
                title: 'Source video',
                description: 'Source description',
                thumbnails: { high: { url: 'https://img.youtube.test/video.jpg' } },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [
            {
              id: 'source-video',
              status: { privacyStatus: 'public' },
              contentDetails: { duration: 'PT1M5S' },
            },
          ],
        }),
      );
    const service = new ChannelImportSyncService({
      db,
      fetch,
      env,
      now: () => now,
      createId: () => 'catalogue-video-1',
    });

    await expect(service.runNextBatch()).resolves.toBe('processed');

    const [channel] = await db
      .select({ status: importedChannels.status, count: importedChannels.importedVideoCount })
      .from(importedChannels);
    expect(channel).toEqual({ status: 'ready', count: 1 });
    const [video] = await db
      .select({
        sourceUrl: importedChannelVideos.sourceUrl,
        embedUrl: importedChannelVideos.embedUrl,
        durationSeconds: importedChannelVideos.durationSeconds,
        playbackStatus: importedChannelVideos.playbackStatus,
      })
      .from(importedChannelVideos);
    expect(video).toEqual({
      sourceUrl: 'https://www.youtube.com/watch?v=source-video',
      embedUrl: 'https://www.youtube-nocookie.com/embed/source-video',
      durationSeconds: 65,
      playbackStatus: 'embedded',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
