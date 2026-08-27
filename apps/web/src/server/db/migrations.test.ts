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
  'w3ds_adapter_mappings',
  'w3ds_private_adapter_projections',
  'w3ds_private_adapter_outbox',
  'w3ds_official_adapter_outbox',
  'w3ds_awareness_receipts',
  'support_reports',
  'support_tasks',
  'w3ds_video_publication_signing_sessions',
  'channel_import_connections',
  'imported_channels',
  'channel_import_oauth_states',
  'imported_channel_videos',
  'channel_import_sync_jobs',
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
  // Web3 Adapter ID map
  'w3ds_adapter_mappings_entity_type_local_id_uidx',
  'w3ds_adapter_mappings_global_id_uidx',
  'w3ds_adapter_mappings_owner_e_name_idx',
  'w3ds_adapter_mappings_schema_id_idx',
  'w3ds_adapter_mappings_entity_table_local_id_idx',
  // Vidak-private adapter sync
  'w3ds_private_adapter_projections_entity_type_local_id_uidx',
  'w3ds_private_adapter_projections_global_id_uidx',
  'w3ds_private_adapter_projections_schema_id_idx',
  'w3ds_private_adapter_projections_owner_e_name_idx',
  // Private support intake and automatic engineering queue
  'support_reports_reporter_created_idx',
  'support_tasks_status_created_idx',
  'w3ds_private_adapter_projections_sync_lookup_idx',
  'w3ds_private_adapter_outbox_entity_type_local_id_uidx',
  'w3ds_private_adapter_outbox_status_idx',
  'w3ds_private_adapter_outbox_entity_type_status_idx',
  'w3ds_official_adapter_outbox_entity_type_local_id_uidx',
  'w3ds_official_adapter_outbox_status_idx',
  'w3ds_official_adapter_outbox_entity_type_status_idx',
  'w3ds_awareness_receipts_global_id_uidx',
  // W3DS signed video publication
  'w3ds_video_publication_signing_status_expires_idx',
  'w3ds_video_publication_signing_owner_video_idx',
  // External channel imports
  'channel_import_connections_owner_provider_account_uidx',
  'channel_import_connections_owner_id_idx',
  'imported_channels_connection_source_channel_uidx',
  'imported_channels_connection_id_idx',
  'imported_channels_status_idx',
  'channel_import_oauth_states_provider_expires_idx',
  'channel_import_oauth_states_owner_id_idx',
  'imported_channel_videos_channel_source_video_uidx',
  'imported_channel_videos_channel_published_idx',
  'channel_import_sync_jobs_channel_uidx',
  'channel_import_sync_jobs_status_locked_idx',
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
    expect(applied.rows).toHaveLength(15);

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

    const adapterColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'w3ds_adapter_mappings'
       order by 1`,
    );
    expect(adapterColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'entity_type',
        'entity_table',
        'local_id',
        'global_id',
        'owner_e_name',
        'schema_id',
        'mapping_version',
        'created_at',
        'updated_at',
      ]),
    );

    const privateProjectionColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'w3ds_private_adapter_projections'
       order by 1`,
    );
    expect(privateProjectionColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'entity_type',
        'local_id',
        'global_id',
        'schema_id',
        'owner_e_name',
        'ownership',
        'catalogue_visibility',
        'payload',
        'payload_hash',
        'mapping_version',
      ]),
    );

    const privateOutboxColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'w3ds_private_adapter_outbox'
       order by 1`,
    );
    expect(privateOutboxColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'entity_type',
        'local_id',
        'operation',
        'sync_status',
        'attempt_count',
        'failure_reason',
      ]),
    );

    const officialOutboxColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'w3ds_official_adapter_outbox'
       order by 1`,
    );
    expect(officialOutboxColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'entity_type',
        'local_id',
        'operation',
        'sync_status',
        'attempt_count',
        'failure_reason',
      ]),
    );

    const awarenessReceiptColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'w3ds_awareness_receipts'
       order by 1`,
    );
    expect(awarenessReceiptColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['id', 'global_id', 'payload_hash', 'created_at', 'updated_at']),
    );

    const signingSessionColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'w3ds_video_publication_signing_sessions'
       order by 1`,
    );
    expect(signingSessionColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'video_id',
        'owner_id',
        'owner_e_name',
        'expires_at',
        'status',
        'error_code',
      ]),
    );
    const supportReportColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'support_reports'
       order by 1`,
    );
    expect(supportReportColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'reporter_id',
        'description',
        'technical_diagnostics',
        'diagnostics_consent',
        'automated_analysis_consent',
      ]),
    );

    const supportTaskColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'support_tasks'
       order by 1`,
    );
    expect(supportTaskColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'report_id',
        'status',
        'analysis_attempt_count',
        'last_analyzed_at',
        'resolution_summary',
      ]),
    );

    const importConnectionColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_import_connections'
       order by 1`,
    );
    expect(importConnectionColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'owner_id',
        'provider',
        'provider_account_id',
        'encrypted_access_token',
        'encrypted_refresh_token',
        'granted_scopes',
      ]),
    );

    const importedChannelColumns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'imported_channels'
       order by 1`,
    );
    expect(importedChannelColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'connection_id',
        'source_channel_id',
        'status',
        'imported_video_count',
        'last_synced_at',
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
    expect(Number(applied.rows[0]?.count)).toBe(15);
  });
});
