import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

const requiredTables = [
  'w3ds_platform_users',
  'w3ds_platform_evault',
  'w3ds_login_offers',
  'w3ds_platform_sessions',
  'creator_channels',
  'videos',
  'media_assets',
  'w3ds_authorization_sync',
] as const;

const requiredIndexes = [
  // Auth
  'w3ds_login_offers_status_expires_idx',
  'w3ds_platform_sessions_user_id_idx',
  'w3ds_platform_sessions_refresh_expires_idx',
  'w3ds_platform_users_e_name_unique',
  // Video / channel
  'creator_channels_owner_id_idx',
  'creator_channels_owner_id_unique',
  'creator_channels_handle_unique',
  'videos_owner_id_status_idx',
  'videos_channel_id_idx',
  'videos_public_video_id_idx',
  'videos_public_video_id_unique',
  // Media
  'media_assets_owner_id_idx',
  'media_assets_video_id_idx',
  'media_assets_owner_id_video_id_idx',
  'media_assets_storage_key_unique',
  // Authorization sync
  'w3ds_authorization_sync_resource_subject_scope_uidx',
  'w3ds_authorization_sync_status_idx',
  'w3ds_authorization_sync_resource_id_idx',
  'w3ds_authorization_sync_owner_platform_user_id_idx',
] as const;

describe('database migrations (empty database → current set)', () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('applies the complete migration journal and creates workflow tables/indexes', async () => {
    client = new PGlite();
    const db = drizzle(client);

    const before = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by 1",
    );
    expect(before.rows.map((row) => row.tablename)).toEqual([]);

    await migrate(db, { migrationsFolder });

    const tables = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by 1",
    );
    const tableNames = tables.rows.map((row) => row.tablename);
    for (const table of requiredTables) {
      expect(tableNames).toContain(table);
    }

    const indexes = await client.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' order by 1",
    );
    const indexNames = indexes.rows.map((row) => row.indexname);
    for (const index of requiredIndexes) {
      expect(indexNames).toContain(index);
    }

    // Journal completeness: drizzle_migrations records every applied file.
    const applied = await client.query<{ hash: string; created_at: number }>(
      'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
    );
    expect(applied.rows).toHaveLength(6);

    // Columns required by the authenticated video workflow.
    const videoColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'videos'
       order by 1`,
    );
    expect(videoColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'channel_id',
        'owner_id',
        'title',
        'status',
        'visibility',
        'public_video_id',
        'published_at',
      ]),
    );

    const mediaColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'media_assets'
       order by 1`,
    );
    expect(mediaColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'owner_id',
        'video_id',
        'storage_key',
        'content_type',
        'byte_size',
        'upload_state',
      ]),
    );

    const syncColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'w3ds_authorization_sync'
       order by 1`,
    );
    expect(syncColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'resource_id',
        'subject_e_name',
        'scope',
        'intent',
        'sync_status',
        'failure_reason',
      ]),
    );
  });

  it('is idempotent when migrate is invoked twice on the same empty-started database', async () => {
    client = new PGlite();
    const db = drizzle(client);
    await migrate(db, { migrationsFolder });
    await migrate(db, { migrationsFolder });

    const applied = await client.query<{ count: string }>(
      'select count(*)::text as count from drizzle.__drizzle_migrations',
    );
    expect(Number(applied.rows[0]?.count)).toBe(6);
  });
});
