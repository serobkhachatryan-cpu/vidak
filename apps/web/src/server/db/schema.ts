import type { AuthUserPermissions, Role } from '@w3ds/auth';
import type { VideoCategory, VideoLanguage, VideoStatus, VideoVisibility } from '@w3ds/types';
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
 * Creator video drafts. Product `Video` rows with draft lifecycle only —
 * no eVault sync or published catalog in this milestone. Binary media is
 * tracked separately via `media_assets` + the server-only MediaStorage adapter.
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
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('videos_owner_id_status_idx').on(table.ownerId, table.status),
    index('videos_channel_id_idx').on(table.channelId),
  ],
);

/**
 * Upload lifecycle for durable media attached to a creator video draft.
 * Suitable for later multipart / processing phases; no public playback yet.
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

export type W3dsPlatformUserRow = typeof w3dsPlatformUsers.$inferSelect;
export type W3dsLoginOfferRow = typeof w3dsLoginOffers.$inferSelect;
export type W3dsPlatformSessionRow = typeof w3dsPlatformSessions.$inferSelect;
export type CreatorChannelRow = typeof creatorChannels.$inferSelect;
export type VideoRow = typeof videos.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;
