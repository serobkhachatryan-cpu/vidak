import type { AuthUserPermissions, Role } from '@w3ds/auth';
import { boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
