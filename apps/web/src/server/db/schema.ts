import type { AuthUserPermissions, Role } from '@w3ds/auth';
import type {
  ChannelImportProvider,
  VideoCategory,
  VideoLanguage,
  VideoStatus,
  VideoVisibility,
} from '@w3ds/types';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { W3dsAdapterEntityType } from '../w3ds-adapter-types';

export type { W3dsAdapterEntityType };

/**
 * Durable W3DS platform identity. One row per global eName.
 * Server-only — never serialized as a raw DB record to browsers.
 */
export const w3dsPlatformUsers = pgTable('w3ds_platform_users', {
  id: text('id').primaryKey(),
  eName: text('e_name').notNull().unique(),
  eVaultId: text('e_vault_id').notNull(),
  eVaultUri: text('e_vault_uri'),
  displayName: text('display_name').notNull(),
  verifiedFullNameDecision: text('verified_full_name_decision').$type<
    'granted' | 'declined' | null
  >(),
  handle: text('handle'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  roles: jsonb('roles').$type<Role[]>().notNull(),
  capabilities: jsonb('capabilities').$type<string[]>().notNull(),
  permissions: jsonb('permissions').$type<AuthUserPermissions>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

/**
 * The single eVault owned by Vidak itself, distinct from every user eVault.
 * This is a server-only cache of the documented provisioning result and
 * PlatformProfile discovery data; it contains no provisioning credential.
 */
export const w3dsPlatformEVault = pgTable('w3ds_platform_evault', {
  id: text('id').primaryKey(),
  eName: text('e_name').notNull().unique(),
  eVaultUri: text('e_vault_uri').notNull(),
  platformName: text('platform_name').notNull(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull(),
  profileVersion: text('profile_version').notNull(),
  publicUrl: text('public_url').notNull(),
  logoUrl: text('logo_url').notNull(),
  category: text('category').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
});

/**
 * Local creator channel owned by a platform user.
 * One channel per owner for this milestone; product `Channel` projection.
 */
export const creatorChannels = pgTable(
  'creator_channels',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => w3dsPlatformUsers.id)
      .unique(),
    handle: text('handle').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    avatarUrl: text('avatar_url'),
    bannerUrl: text('banner_url'),
    subscriberCount: integer('subscriber_count').notNull().default(0),
    videoCount: integer('video_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('creator_channels_owner_id_idx').on(table.ownerId)],
);

/**
 * Creator videos with an explicit draft | published lifecycle.
 * Visibility (`private` | `unlisted` | `public`) is independent of lifecycle.
 * `public_video_id` is assigned on first publish for anonymous public detail /
 * discovery / media routes. Binary media is tracked separately via
 * `media_assets` + the server-only MediaStorage adapter.
 */
export const videos = pgTable(
  'videos',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id')
      .notNull()
      .references(() => creatorChannels.id),
    ownerId: text('owner_id')
      .notNull()
      .references(() => w3dsPlatformUsers.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    thumbnailUrl: text('thumbnail_url').notNull().default(''),
    durationSeconds: integer('duration_seconds').notNull().default(0),
    status: text('status').$type<VideoStatus>().notNull(),
    visibility: text('visibility').$type<VideoVisibility>().notNull(),
    category: text('category').$type<VideoCategory>(),
    language: text('language').$type<VideoLanguage>(),
    tags: jsonb('tags').$type<string[]>().notNull(),
    viewCount: integer('view_count').notNull().default(0),
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    /**
     * Opaque stable public identifier. Null until first publish; unique when set.
     * Survives unpublish so later public routes can keep a stable key.
     */
    publicVideoId: text('public_video_id').unique(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('videos_owner_id_status_idx').on(table.ownerId, table.status),
    index('videos_channel_id_idx').on(table.channelId),
    index('videos_public_video_id_idx').on(table.publicVideoId),
  ],
);

/**
 * Upload lifecycle for durable media attached to a creator video.
 * Owner transfer is draft-scoped; anonymous streaming is gated by published
 * public/unlisted visibility on the linked video.
 */
export type MediaUploadState = 'pending' | 'uploading' | 'ready' | 'failed';

/**
 * Durable media asset metadata owned by a platform user and linked to one of
 * that user's creator video drafts. Bytes live behind MediaStorage via an
 * opaque `storage_key` — never a user-supplied filesystem path.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => w3dsPlatformUsers.id),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull().unique(),
    originalFilename: text('original_filename').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    uploadState: text('upload_state').$type<MediaUploadState>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('media_assets_owner_id_idx').on(table.ownerId),
    index('media_assets_video_id_idx').on(table.videoId),
    index('media_assets_owner_id_video_id_idx').on(table.ownerId, table.videoId),
  ],
);

/** Local cache of derived still-frame previews. Never written to eVault. */
export type VideoPreviewStatus = 'pending' | 'ready' | 'failed';
export type VideoPreviewSourceKind = 'owned-video' | 'evault-file';

/**
 * Derived poster images for grid cards. Bytes live in MediaStorage.
 * Authorization is always re-checked against the source video — this table
 * is not a sharing record and never changes visibility.
 */
export const videoPreviewAssets = pgTable(
  'video_preview_assets',
  {
    id: text('id').primaryKey(),
    sourceKind: text('source_kind').$type<VideoPreviewSourceKind>().notNull(),
    sourceKey: text('source_key').notNull(),
    storageKey: text('storage_key'),
    status: text('status').$type<VideoPreviewStatus>().notNull(),
    captureSeconds: integer('capture_seconds'),
    byteSize: integer('byte_size'),
    contentType: text('content_type'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('video_preview_assets_source_uidx').on(table.sourceKind, table.sourceKey),
    index('video_preview_assets_status_idx').on(table.status),
  ],
);

/**
 * Anonymous public view receipts. Stores only a keyed hash of viewer material —
 * never raw IP addresses, eNames, tokens, or third-party tracking data.
 * Counted views update `videos.view_count` locally and are never written to eVault.
 */
export const videoViewEvents = pgTable(
  'video_view_events',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    publicVideoId: text('public_video_id').notNull(),
    viewerKeyHash: text('viewer_key_hash').notNull(),
    countedAt: timestamp('counted_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('video_view_events_public_video_viewer_uidx').on(
      table.publicVideoId,
      table.viewerKeyHash,
    ),
    index('video_view_events_video_id_idx').on(table.videoId),
  ],
);

/**
 * One-time login offers for w3ds://auth.
 * Status transitions and expiry are enforced by store operations.
 */
export const w3dsLoginOffers = pgTable(
  'w3ds_login_offers',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status')
      .$type<'pending' | 'verifying' | 'completed' | 'expired' | 'failed'>()
      .notNull(),
    platformSessionId: text('platform_session_id'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('w3ds_login_offers_status_expires_idx').on(table.status, table.expiresAt)],
);

/**
 * Platform sessions. Stores JWT identifiers (jti), never raw access/refresh JWTs.
 */
export const w3dsPlatformSessions = pgTable(
  'w3ds_platform_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => w3dsPlatformUsers.id),
    accessJti: text('access_jti').notNull(),
    refreshJti: text('refresh_jti').notNull(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('w3ds_platform_sessions_user_id_idx').on(table.userId),
    index('w3ds_platform_sessions_refresh_expires_idx').on(table.refreshExpiresAt),
  ],
);

/**
 * Durable intent + sync state for W3DS resource authorization grants.
 * Server-only — never expose rows, credentials, or raw remote errors to browsers.
 *
 * One row per (resourceId, subjectEName, scope). Intent is grant|revoke; remote
 * mutations are retryable via status/attempt metadata. Failure reasons must be
 * pre-redacted (no secrets, tokens, or credential-bearing URLs).
 */
export type W3dsAuthorizationSyncIntent = 'grant' | 'revoke';
export type W3dsAuthorizationSyncStatus = 'pending' | 'synced' | 'failed' | 'revoked';
export type W3dsAuthorizationResourceKind = 'creator_video' | 'media_asset';
export type W3dsAuthorizationAccessScope =
  | 'video:owner'
  | 'video:read'
  | 'video:discover'
  | 'media:owner'
  | 'media:read';

export const w3dsAuthorizationSync = pgTable(
  'w3ds_authorization_sync',
  {
    id: text('id').primaryKey(),
    resourceKind: text('resource_kind').$type<W3dsAuthorizationResourceKind>().notNull(),
    /** Opaque Phase 1 resource id (`vra_1_*`). */
    resourceId: text('resource_id').notNull(),
    localResourceId: text('local_resource_id').notNull(),
    ownerPlatformUserId: text('owner_platform_user_id').notNull(),
    ownerEName: text('owner_e_name').notNull(),
    subjectPlatformUserId: text('subject_platform_user_id'),
    subjectEName: text('subject_e_name').notNull(),
    subjectEVaultId: text('subject_e_vault_id'),
    scope: text('scope').$type<W3dsAuthorizationAccessScope>().notNull(),
    intent: text('intent').$type<W3dsAuthorizationSyncIntent>().notNull(),
    syncStatus: text('sync_status').$type<W3dsAuthorizationSyncStatus>().notNull(),
    externalGrantId: text('external_grant_id'),
    externalOwnerBindingId: text('external_owner_binding_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true, mode: 'date' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    /** Safe, non-secret failure summary only. */
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('w3ds_authorization_sync_resource_subject_scope_uidx').on(
      table.resourceId,
      table.subjectEName,
      table.scope,
    ),
    index('w3ds_authorization_sync_status_idx').on(table.syncStatus),
    index('w3ds_authorization_sync_resource_id_idx').on(table.resourceId),
    index('w3ds_authorization_sync_owner_platform_user_id_idx').on(table.ownerPlatformUserId),
  ],
);

/**
 * Durable Web3 Adapter ID map: local product entity ↔ global MetaEnvelope id.
 * Server-only — never serialize rows or schemaIds to browsers.
 *
 * Unique on (entity_type, local_id) and on global_id so outbound sync and
 * inbound Awareness projections stay idempotent (Web3 Adapter MappingDatabase).
 */
export const w3dsAdapterMappings = pgTable(
  'w3ds_adapter_mappings',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').$type<W3dsAdapterEntityType>().notNull(),
    /** Local Postgres table / entity collection name (e.g. videos). */
    entityTable: text('entity_table').notNull(),
    localId: text('local_id').notNull(),
    /**
     * Stable private projection / envelope id (Vidak-private sync) or remote
     * MetaEnvelope id (future MetaState path). Never treat private IDs as
     * MetaState-issued.
     */
    globalId: text('global_id').notNull(),
    ownerEName: text('owner_e_name').notNull(),
    /** Ontology schemaId that typed the projection / envelope. */
    schemaId: text('schema_id').notNull(),
    mappingVersion: integer('mapping_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('w3ds_adapter_mappings_entity_type_local_id_uidx').on(
      table.entityType,
      table.localId,
    ),
    uniqueIndex('w3ds_adapter_mappings_global_id_uidx').on(table.globalId),
    index('w3ds_adapter_mappings_owner_e_name_idx').on(table.ownerEName),
    index('w3ds_adapter_mappings_schema_id_idx').on(table.schemaId),
    index('w3ds_adapter_mappings_entity_table_local_id_idx').on(table.entityTable, table.localId),
  ],
);

/**
 * Durable Vidak-private ontology projections.
 * Server-only — not MetaState MetaEnvelopes and not interoperable public W3DS data.
 */
export type W3dsPrivateAdapterEntityType = 'channel' | 'video' | 'playlist' | 'comment';
export type W3dsPrivateAdapterSyncStatus = 'pending' | 'synced' | 'failed';
export type W3dsPrivateAdapterSyncOperation = 'upsert';

export const w3dsPrivateAdapterProjections = pgTable(
  'w3ds_private_adapter_projections',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').$type<W3dsPrivateAdapterEntityType>().notNull(),
    localId: text('local_id').notNull(),
    globalId: text('global_id').notNull(),
    schemaId: text('schema_id').notNull(),
    ownerEName: text('owner_e_name').notNull(),
    /** Always vidak_private — never MetaState / public W3DS ownership. */
    ownership: text('ownership').notNull().default('vidak_private'),
    /** Catalogue visibility label (private); distinct from entity visibility. */
    catalogueVisibility: text('catalogue_visibility').notNull().default('private'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    mappingVersion: integer('mapping_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('w3ds_private_adapter_projections_entity_type_local_id_uidx').on(
      table.entityType,
      table.localId,
    ),
    uniqueIndex('w3ds_private_adapter_projections_global_id_uidx').on(table.globalId),
    index('w3ds_private_adapter_projections_schema_id_idx').on(table.schemaId),
    index('w3ds_private_adapter_projections_owner_e_name_idx').on(table.ownerEName),
    index('w3ds_private_adapter_projections_sync_lookup_idx').on(
      table.entityType,
      table.payloadHash,
    ),
  ],
);

/**
 * Retry-safe outbox for Vidak-private adapter sync.
 * No remote W3DS calls — processes durable local projections only.
 */
export const w3dsPrivateAdapterOutbox = pgTable(
  'w3ds_private_adapter_outbox',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').$type<W3dsPrivateAdapterEntityType>().notNull(),
    localId: text('local_id').notNull(),
    operation: text('operation').$type<W3dsPrivateAdapterSyncOperation>().notNull(),
    syncStatus: text('sync_status').$type<W3dsPrivateAdapterSyncStatus>().notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true, mode: 'date' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    /** Safe, non-secret failure summary only. */
    failureReason: text('failure_reason'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('w3ds_private_adapter_outbox_entity_type_local_id_uidx').on(
      table.entityType,
      table.localId,
    ),
    index('w3ds_private_adapter_outbox_status_idx').on(table.syncStatus),
    index('w3ds_private_adapter_outbox_entity_type_status_idx').on(
      table.entityType,
      table.syncStatus,
    ),
  ],
);

/**
 * Retry-safe outbox for official (MetaState) adapter handleChange.
 * Distinct from w3ds_private_adapter_outbox. Remote writes stay gated off.
 */
export type W3dsOfficialAdapterEntityType = 'channel' | 'video' | 'playlist' | 'comment';
export type W3dsOfficialAdapterSyncStatus = 'pending' | 'synced' | 'failed';
export type W3dsOfficialAdapterSyncOperation = 'upsert';

export const w3dsOfficialAdapterOutbox = pgTable(
  'w3ds_official_adapter_outbox',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').$type<W3dsOfficialAdapterEntityType>().notNull(),
    localId: text('local_id').notNull(),
    operation: text('operation').$type<W3dsOfficialAdapterSyncOperation>().notNull(),
    syncStatus: text('sync_status').$type<W3dsOfficialAdapterSyncStatus>().notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true, mode: 'date' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    /** Safe, non-secret failure summary only. */
    failureReason: text('failure_reason'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('w3ds_official_adapter_outbox_entity_type_local_id_uidx').on(
      table.entityType,
      table.localId,
    ),
    index('w3ds_official_adapter_outbox_status_idx').on(table.syncStatus),
    index('w3ds_official_adapter_outbox_entity_type_status_idx').on(
      table.entityType,
      table.syncStatus,
    ),
  ],
);

/**
 * Durable AaaS webhook receipts keyed by MetaEnvelope id.
 * Server-only. Slice 1 records verified deliveries; it does not apply product rows.
 */
export const w3dsAwarenessReceipts = pgTable(
  'w3ds_awareness_receipts',
  {
    id: text('id').primaryKey(),
    globalId: text('global_id').notNull(),
    payloadHash: text('payload_hash').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('w3ds_awareness_receipts_global_id_uidx').on(table.globalId)],
);

/**
 * One-time W3DS signing sessions for the opt-in creator-video publication
 * consent flow. The signature itself is never retained: it is verified
 * server-side against Registry-attested eVault keys before the local publish.
 */
export const w3dsVideoPublicationSigningSessions = pgTable(
  'w3ds_video_publication_signing_sessions',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id')
      .notNull()
      .references(() => w3dsPlatformUsers.id),
    ownerEName: text('owner_e_name').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: text('status')
      .$type<'pending' | 'verifying' | 'completed' | 'expired' | 'failed' | 'security_violation'>()
      .notNull(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('w3ds_video_publication_signing_status_expires_idx').on(table.status, table.expiresAt),
    index('w3ds_video_publication_signing_owner_video_idx').on(table.ownerId, table.videoId),
  ],
);

/**
 * A private, user-submitted product-support report. Report contents are never
 * written to operational logs, copied to a public tracker, or exposed through
 * a public API. Technical diagnostics are stored only after explicit consent.
 */
export const supportReports = pgTable(
  'support_reports',
  {
    id: text('id').primaryKey(),
    reporterId: text('reporter_id')
      .notNull()
      .references(() => w3dsPlatformUsers.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    technicalDiagnostics: jsonb('technical_diagnostics').$type<Record<string, unknown>>(),
    diagnosticsConsent: boolean('diagnostics_consent').notNull().default(false),
    automatedAnalysisConsent: boolean('automated_analysis_consent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('support_reports_reporter_created_idx').on(table.reporterId, table.createdAt)],
);

/**
 * Internal engineering work created only when a reporter gives explicit
 * automated-analysis consent. This is Vidak's private queue, not a public
 * GitHub issue or an externally visible W3DS record.
 */
export type SupportTaskStatus = 'queued' | 'in_progress' | 'resolved' | 'needs_more_info';

export const supportTasks = pgTable(
  'support_tasks',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id')
      .notNull()
      .references(() => supportReports.id, { onDelete: 'cascade' })
      .unique(),
    status: text('status').$type<SupportTaskStatus>().notNull(),
    analysisAttemptCount: integer('analysis_attempt_count').notNull().default(0),
    lastAnalyzedAt: timestamp('last_analyzed_at', { withTimezone: true, mode: 'date' }),
    resolutionSummary: text('resolution_summary'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('support_tasks_status_created_idx').on(table.status, table.createdAt)],
);

/**
 * Server-only OAuth grants for external video channels. Access and refresh
 * tokens are encrypted before persistence and are never serialised to a
 * browser, W3DS projection, log, or support record.
 */
export const channelImportConnections = pgTable(
  'channel_import_connections',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => w3dsPlatformUsers.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ChannelImportProvider>().notNull(),
    /** OAuth credentials or the documented public YouTube Atom feed. */
    connectionKind: text('connection_kind')
      .$type<'oauth' | 'public_feed'>()
      .notNull()
      .default('oauth'),
    /** Provider-owned stable account/channel identity, never an email address. */
    providerAccountId: text('provider_account_id').notNull(),
    accountLabel: text('account_label').notNull(),
    /** Null only for a public feed, which has no user credential to retain. */
    encryptedAccessToken: text('encrypted_access_token'),
    encryptedRefreshToken: text('encrypted_refresh_token'),
    grantedScopes: jsonb('granted_scopes').$type<string[]>().notNull(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('channel_import_connections_owner_provider_account_uidx').on(
      table.ownerId,
      table.provider,
      table.providerAccountId,
    ),
    index('channel_import_connections_owner_id_idx').on(table.ownerId),
  ],
);

/**
 * A selected source channel. It is intentionally separate from creator_channels:
 * imported source items do not falsely claim Vidak-hosted media ownership.
 */
export type ChannelImportStatus = 'connected' | 'syncing' | 'ready' | 'needs_reconnect' | 'failed';

export const importedChannels = pgTable(
  'imported_channels',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => channelImportConnections.id, { onDelete: 'cascade' }),
    sourceChannelId: text('source_channel_id').notNull(),
    /** Provider collection identity used to continue paginated catalogue scans. */
    sourceCatalogueId: text('source_catalogue_id'),
    title: text('title').notNull(),
    sourceUrl: text('source_url').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    status: text('status').$type<ChannelImportStatus>().notNull(),
    importedVideoCount: integer('imported_video_count').notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }),
    /** Safe, provider-agnostic status only; never raw response content. */
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('imported_channels_connection_source_channel_uidx').on(
      table.connectionId,
      table.sourceChannelId,
    ),
    index('imported_channels_connection_id_idx').on(table.connectionId),
    index('imported_channels_status_idx').on(table.status),
  ],
);

/**
 * One-time OAuth callback state. Only an HMAC of the random browser value is
 * stored, protecting the callback even if a database read is exposed.
 */
/** Metadata-only provider catalogue entries. Source media is never stored as a Vidak media asset. */
export type ImportedChannelVideoPlaybackStatus = 'embedded' | 'source_only';
export type ImportedChannelVideoVisibility = 'public' | 'unlisted' | 'private' | 'unknown';

export const importedChannelVideos = pgTable(
  'imported_channel_videos',
  {
    id: text('id').primaryKey(),
    importedChannelId: text('imported_channel_id')
      .notNull()
      .references(() => importedChannels.id, { onDelete: 'cascade' }),
    sourceVideoId: text('source_video_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    sourceUrl: text('source_url').notNull(),
    /** Never a media-storage location; only a provider-controlled player URL. */
    embedUrl: text('embed_url'),
    thumbnailUrl: text('thumbnail_url'),
    durationSeconds: integer('duration_seconds'),
    sourceVisibility: text('source_visibility').$type<ImportedChannelVideoVisibility>().notNull(),
    playbackStatus: text('playback_status').$type<ImportedChannelVideoPlaybackStatus>().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('imported_channel_videos_channel_source_video_uidx').on(
      table.importedChannelId,
      table.sourceVideoId,
    ),
    index('imported_channel_videos_channel_published_idx').on(
      table.importedChannelId,
      table.publishedAt,
    ),
  ],
);

/** A leased cursor job keeps provider scans durable and bounded. */
export type ChannelImportSyncJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export const channelImportSyncJobs = pgTable(
  'channel_import_sync_jobs',
  {
    id: text('id').primaryKey(),
    importedChannelId: text('imported_channel_id')
      .notNull()
      .references(() => importedChannels.id, { onDelete: 'cascade' }),
    status: text('status').$type<ChannelImportSyncJobStatus>().notNull(),
    nextCursor: text('next_cursor'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    /** Safe status only, never provider response or credentials. */
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('channel_import_sync_jobs_channel_uidx').on(table.importedChannelId),
    index('channel_import_sync_jobs_status_locked_idx').on(table.status, table.lockedUntil),
  ],
);

export const channelImportOAuthStates = pgTable(
  'channel_import_oauth_states',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => w3dsPlatformUsers.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ChannelImportProvider>().notNull(),
    stateHash: text('state_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('channel_import_oauth_states_provider_expires_idx').on(table.provider, table.expiresAt),
    index('channel_import_oauth_states_owner_id_idx').on(table.ownerId),
  ],
);

export type VideoViewEventRow = typeof videoViewEvents.$inferSelect;
export type W3dsPlatformSessionRow = typeof w3dsPlatformSessions.$inferSelect;
export type CreatorChannelRow = typeof creatorChannels.$inferSelect;
export type VideoRow = typeof videos.$inferSelect;
export type W3dsPlatformUserRow = typeof w3dsPlatformUsers.$inferSelect;
export type W3dsPlatformEVaultRow = typeof w3dsPlatformEVault.$inferSelect;
export type W3dsLoginOfferRow = typeof w3dsLoginOffers.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
export type W3dsAuthorizationSyncRow = typeof w3dsAuthorizationSync.$inferSelect;
export type W3dsAdapterMappingRow = typeof w3dsAdapterMappings.$inferSelect;
export type W3dsPrivateAdapterProjectionRow = typeof w3dsPrivateAdapterProjections.$inferSelect;
export type W3dsPrivateAdapterOutboxRow = typeof w3dsPrivateAdapterOutbox.$inferSelect;
export type W3dsOfficialAdapterOutboxRow = typeof w3dsOfficialAdapterOutbox.$inferSelect;
export type W3dsAwarenessReceiptRow = typeof w3dsAwarenessReceipts.$inferSelect;
export type W3dsVideoPublicationSigningSessionRow =
  typeof w3dsVideoPublicationSigningSessions.$inferSelect;
export type SupportReportRow = typeof supportReports.$inferSelect;
export type SupportTaskRow = typeof supportTasks.$inferSelect;
export type ChannelImportConnectionRow = typeof channelImportConnections.$inferSelect;
export type ImportedChannelRow = typeof importedChannels.$inferSelect;
export type ChannelImportOAuthStateRow = typeof channelImportOAuthStates.$inferSelect;
