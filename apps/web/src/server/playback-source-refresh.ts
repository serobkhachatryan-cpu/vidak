/// <reference path="./server-only-module.d.ts" />
import 'server-only';

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';

import { getPlaybackW3dsDatabase, type W3dsDatabase } from './db/client';
import { playbackSourceRefreshEpochs } from './db/schema';
import { parseSafePrivateMediaUpstreamUrl } from './private-media-upstream';
import {
  sharedVideoAuthorizationReceiptTtlMs,
  verifySharedVideoAuthorizationReceipt,
} from './shared-video-authorization-receipt';

/**
 * A durable, cross-replica fence for an explicit shared-video recovery.
 * A caller claims a short lease, resolves eVault outside a transaction, then
 * conditionally publishes an encrypted source. A newer claim increments the
 * epoch, so an older request can never publish or issue the newer source.
 */

const minimumSecretLength = 32;
const bindingKeyDomain = 'vidak.playback-source-refresh.binding-key.v1';
const bindingDomain = 'vidak.playback-source-refresh.binding.v1';
const leaseKeyDomain = 'vidak.playback-source-refresh.lease-key.v1';
const leaseDomain = 'vidak.playback-source-refresh.lease.v1';
const encryptionKeyDomain = 'vidak.playback-source-refresh.encryption-key.v1';
const encryptionAadDomain = 'vidak.playback-source-refresh.payload.v1\u0000';
const encryptedPayloadVersion = 'v1';
const maxMediaUrlLength = 16_384;
const maxEncryptedPayloadLength = 48_000;
const maxDateMs = 8_640_000_000_000_000;
const maxExpiredPlaybackSourceRefreshRowsPerCleanup = 32;
export const playbackSourceRefreshCleanupIntervalMs = 30_000;

// This covers all bounded source work plus scheduling headroom. It remains
// substantially shorter than the 45-second receipt lifetime.
export const playbackSourceRefreshLeaseTtlMs = 30_000;
// The durable handoff outlives the receipt by a small margin so it cannot
// disappear immediately before the just-minted 45-second receipt. Every read
// still verifies that receipt, so this is retention only—not a longer grant.
export const playbackSourceRefreshStateTtlMs = sharedVideoAuthorizationReceiptTtlMs + 15_000;

export interface PlaybackSourceRefreshBinding {
  viewerEName: string;
  streamId: string;
  now?: number;
}

/**
 * A recovery may claim a missing, failed, or expired lease. It can replace a
 * healthy ready handoff only by supplying the exact epoch that the playback
 * route just observed rejected upstream. This prevents a browser recovery
 * POST, late native ranges, and an outdated replica from serially invalidating
 * a source another replica has already recovered.
 */
export interface PlaybackSourceRefreshClaimInput extends PlaybackSourceRefreshBinding {
  /**
   * A server-only source-rejection recovery may replace a ready row only when
   * it still observes this exact stale epoch. If another replica has already
   * published a newer ready source, the CAS fails and the caller rereads that
   * newer handoff instead of overwriting it.
   */
  replaceReadyEpoch?: number;
}

export interface PlaybackSourceRefreshReadInput extends PlaybackSourceRefreshBinding {
  /** Required: a database row is never a browser authorization grant. */
  receipt: string | null | undefined;
}

export interface PlaybackSourceRefreshLease {
  /** Monotonic only within this server-keyed viewer-and-stream binding. */
  epoch: number;
  /** Opaque server-only lease; only a keyed fingerprint is persisted. */
  token: string;
  expiresAt: number;
}

export type PlaybackSourceRefreshClaim =
  | { kind: 'acquired'; lease: PlaybackSourceRefreshLease }
  | { kind: 'in_progress' }
  | { kind: 'unavailable' };

export type PlaybackSourceRefreshState =
  | { kind: 'absent' }
  | { kind: 'resolving'; epoch: number }
  /**
   * The owner disappeared before publishing. This is deliberately distinct
   * from an active resolver so a subsequent request can atomically take the
   * lease instead of failing until the state-retention TTL expires.
   */
  | { kind: 'retryable'; epoch: number }
  | { kind: 'ready'; epoch: number; mediaUrl: string }
  | { kind: 'unavailable' };

export interface PublishPlaybackSourceRefreshInput extends PlaybackSourceRefreshBinding {
  lease: PlaybackSourceRefreshLease;
  mediaUrl: string;
}

export interface FailPlaybackSourceRefreshInput extends PlaybackSourceRefreshBinding {
  lease: PlaybackSourceRefreshLease;
}

export interface PlaybackSourceRefreshStore {
  claim(input: PlaybackSourceRefreshClaimInput): Promise<PlaybackSourceRefreshClaim>;
  publish(input: PublishPlaybackSourceRefreshInput): Promise<boolean>;
  fail(input: FailPlaybackSourceRefreshInput): Promise<boolean>;
  read(input: PlaybackSourceRefreshReadInput): Promise<PlaybackSourceRefreshState>;
}

export interface PlaybackSourceRefreshStoreOptions {
  env?: Record<string, string | undefined>;
  encryptionKey?: Buffer;
}

interface AuthorizedBinding {
  bindingHash: string;
  now: number;
}

interface ExpiredCleanupState {
  nextAllowedAt: number;
  pending: Promise<void> | undefined;
}

// `getPlaybackW3dsDatabase()` is process-singleton in production, so this
// coordinates every store instance in a replica without retaining test
// databases forever.
const expiredCleanupStates = new WeakMap<W3dsDatabase, ExpiredCleanupState>();

/** Deliberately generic: no identity, receipt, or source leaks through it. */
export class PlaybackSourceRefreshConfigurationError extends Error {
  constructor() {
    super(
      `Playback source refresh requires W3DS_AUTH_JWT_SECRET with at least ${minimumSecretLength} characters.`,
    );
  }
}

/**
 * PostgreSQL-backed implementation. Claim and publish are individual atomic
 * statements: no transaction is held while eVault or media I/O runs.
 */
export class PostgresPlaybackSourceRefreshStore implements PlaybackSourceRefreshStore {
  private readonly authorizationEnv: Record<string, string | undefined>;
  private readonly bindingKey: Buffer;
  private readonly leaseKey: Buffer;
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly db: W3dsDatabase,
    options: PlaybackSourceRefreshStoreOptions = {},
  ) {
    this.authorizationEnv = options.env ?? process.env;
    this.bindingKey = deriveKey(this.authorizationEnv, bindingKeyDomain);
    this.leaseKey = deriveKey(this.authorizationEnv, leaseKeyDomain);
    this.encryptionKey = Buffer.from(
      options.encryptionKey ?? deriveKey(this.authorizationEnv, encryptionKeyDomain),
    );
    if (this.encryptionKey.byteLength !== 32) throw new PlaybackSourceRefreshConfigurationError();
  }

  async claim(input: PlaybackSourceRefreshClaimInput): Promise<PlaybackSourceRefreshClaim> {
    const authorized = this.authorizeBinding(input);
    const replaceReadyEpoch = normalizeReplaceReadyEpoch(input.replaceReadyEpoch);
    if (
      !authorized ||
      !canAddTtl(authorized.now, playbackSourceRefreshStateTtlMs) ||
      (input.replaceReadyEpoch !== undefined && replaceReadyEpoch === undefined)
    ) {
      return { kind: 'unavailable' };
    }
    const now = new Date(authorized.now);
    // Production recovery requests do not supply `now`. Evaluate the lease
    // fence at statement execution time so a queued claim cannot create an
    // already-expired lease from a timestamp captured before the database
    // connection became available. Explicit test clocks retain deterministic
    // behavior for the store's cross-replica simulations.
    const databaseNow = databaseTimestamp(input, now);
    const leaseExpiresAt = databaseTimestampAfter(input, now, playbackSourceRefreshLeaseTtlMs);
    const expiresAt = databaseTimestampAfter(input, now, playbackSourceRefreshStateTtlMs);
    const token = randomBytes(24).toString('base64url');
    const leaseHash = hashLease(this.leaseKey, token);
    try {
      // Atomic compare-and-swap: a recovery may take over a failed or expired
      // owner, but it cannot replace a healthy source another replica just
      // recovered unless it observed the exact ready epoch that was rejected.
      const replaceableState =
        replaceReadyEpoch !== undefined
          ? sql`(${playbackSourceRefreshEpochs.status} = 'ready' AND ${playbackSourceRefreshEpochs.epoch} = ${replaceReadyEpoch}) OR ${playbackSourceRefreshEpochs.status} = 'unavailable' OR ${playbackSourceRefreshEpochs.leaseExpiresAt} <= ${databaseNow} OR ${playbackSourceRefreshEpochs.expiresAt} <= ${databaseNow}`
          : sql`(${playbackSourceRefreshEpochs.status} = 'unavailable' OR ${playbackSourceRefreshEpochs.leaseExpiresAt} <= ${databaseNow} OR ${playbackSourceRefreshEpochs.expiresAt} <= ${databaseNow})`;
      const rows = await this.db
        .insert(playbackSourceRefreshEpochs)
        .values({
          bindingHash: authorized.bindingHash,
          epoch: 1,
          status: 'resolving',
          leaseHash,
          leaseExpiresAt,
          encryptedPayload: null,
          expiresAt,
          createdAt: databaseNow,
          updatedAt: databaseNow,
        })
        .onConflictDoUpdate({
          target: playbackSourceRefreshEpochs.bindingHash,
          set: {
            epoch: sql`${playbackSourceRefreshEpochs.epoch} + 1`,
            status: 'resolving',
            leaseHash,
            leaseExpiresAt,
            encryptedPayload: null,
            expiresAt,
            updatedAt: databaseNow,
          },
          // Keep the complete CAS predicate explicit so it can never be
          // widened to undefined and accidentally omitted from this
          // cross-replica fence.
          where: replaceableState,
        })
        .returning({
          epoch: playbackSourceRefreshEpochs.epoch,
          leaseExpiresAt: playbackSourceRefreshEpochs.leaseExpiresAt,
        });
      const row = rows[0];
      if (
        !row ||
        !Number.isSafeInteger(row.epoch) ||
        row.epoch < 1 ||
        !(row.leaseExpiresAt instanceof Date)
      ) {
        return { kind: 'in_progress' };
      }
      this.scheduleExpiredCleanup(authorized.now);
      return {
        kind: 'acquired',
        lease: { epoch: row.epoch, token, expiresAt: row.leaseExpiresAt.getTime() },
      };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async publish(input: PublishPlaybackSourceRefreshInput): Promise<boolean> {
    const authorized = this.authorizeBinding(input);
    const mediaUrl = normalizeSafeMediaUrl(input.mediaUrl);
    const lease = normalizeLease(input.lease);
    if (!authorized || !mediaUrl || !lease || lease.expiresAt <= authorized.now) return false;
    const now = new Date(authorized.now);
    const databaseNow = databaseTimestamp(input, now);
    const expiresAt = databaseTimestampAfter(input, now, playbackSourceRefreshStateTtlMs);
    const encryptedPayload = encryptPayload(
      mediaUrl,
      authorized.bindingHash,
      lease.epoch,
      this.encryptionKey,
    );
    try {
      const rows = await this.db
        .update(playbackSourceRefreshEpochs)
        .set({
          status: 'ready',
          leaseHash: null,
          leaseExpiresAt: null,
          encryptedPayload,
          expiresAt,
          updatedAt: databaseNow,
        })
        .where(
          and(
            eq(playbackSourceRefreshEpochs.bindingHash, authorized.bindingHash),
            eq(playbackSourceRefreshEpochs.epoch, lease.epoch),
            eq(playbackSourceRefreshEpochs.status, 'resolving'),
            eq(playbackSourceRefreshEpochs.leaseHash, hashLease(this.leaseKey, lease.token)),
            gt(playbackSourceRefreshEpochs.leaseExpiresAt, databaseNow),
            gt(playbackSourceRefreshEpochs.expiresAt, databaseNow),
          ),
        )
        .returning({ bindingHash: playbackSourceRefreshEpochs.bindingHash });
      const published = rows.length === 1;
      if (published) this.scheduleExpiredCleanup(authorized.now);
      return published;
    } catch {
      return false;
    }
  }

  /**
   * Releases a failed owner without reopening the stale legacy cache. Readers
   * see `unavailable` and must not use an older URL; the next explicit
   * recovery can immediately claim a new epoch.
   */
  async fail(input: FailPlaybackSourceRefreshInput): Promise<boolean> {
    const authorized = this.authorizeBinding(input);
    const lease = normalizeLease(input.lease);
    if (!authorized || !lease || lease.expiresAt <= authorized.now) return false;
    const now = new Date(authorized.now);
    const databaseNow = databaseTimestamp(input, now);
    const expiresAt = databaseTimestampAfter(input, now, playbackSourceRefreshStateTtlMs);
    try {
      const rows = await this.db
        .update(playbackSourceRefreshEpochs)
        .set({
          status: 'unavailable',
          leaseHash: null,
          leaseExpiresAt: null,
          encryptedPayload: null,
          expiresAt,
          updatedAt: databaseNow,
        })
        .where(
          and(
            eq(playbackSourceRefreshEpochs.bindingHash, authorized.bindingHash),
            eq(playbackSourceRefreshEpochs.epoch, lease.epoch),
            eq(playbackSourceRefreshEpochs.status, 'resolving'),
            eq(playbackSourceRefreshEpochs.leaseHash, hashLease(this.leaseKey, lease.token)),
            gt(playbackSourceRefreshEpochs.leaseExpiresAt, databaseNow),
            gt(playbackSourceRefreshEpochs.expiresAt, databaseNow),
          ),
        )
        .returning({ bindingHash: playbackSourceRefreshEpochs.bindingHash });
      const failed = rows.length === 1;
      if (failed) this.scheduleExpiredCleanup(authorized.now);
      return failed;
    } catch {
      return false;
    }
  }

  async read(input: PlaybackSourceRefreshReadInput): Promise<PlaybackSourceRefreshState> {
    const authorized = this.authorizeReceipt(input);
    if (!authorized) return { kind: 'unavailable' };
    try {
      const [row] = await this.db
        .select()
        .from(playbackSourceRefreshEpochs)
        .where(eq(playbackSourceRefreshEpochs.bindingHash, authorized.bindingHash))
        .limit(1);
      if (!row || row.expiresAt.getTime() <= authorized.now) return { kind: 'absent' };
      if (row.status === 'resolving') {
        // An active pending row fences stale receipt-cache fallback. A lease
        // expiry is not terminal, however: claim() already permits a new
        // epoch at that point, so expose a retryable state rather than making
        // playback wait for the much longer state-retention TTL.
        if (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= authorized.now) {
          return { kind: 'retryable', epoch: row.epoch };
        }
        return { kind: 'resolving', epoch: row.epoch };
      }
      if (row.status !== 'ready' || !row.encryptedPayload) return { kind: 'unavailable' };
      const mediaUrl = decryptPayload(
        row.encryptedPayload,
        authorized.bindingHash,
        row.epoch,
        this.encryptionKey,
      );
      if (!mediaUrl) return { kind: 'unavailable' };
      return { kind: 'ready', epoch: row.epoch, mediaUrl };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  private authorizeBinding(input: PlaybackSourceRefreshBinding): AuthorizedBinding | undefined {
    const now = normalizeNow(input.now);
    const viewerEName = validViewerEName(input.viewerEName);
    const streamId = validOpaqueStreamId(input.streamId);
    if (now === undefined || !viewerEName || !streamId) return undefined;
    return { bindingHash: bindingHash(this.bindingKey, viewerEName, streamId), now };
  }

  private authorizeReceipt(input: PlaybackSourceRefreshReadInput): AuthorizedBinding | undefined {
    const binding = this.authorizeBinding(input);
    if (!binding || typeof input.receipt !== 'string') return undefined;
    if (
      !verifySharedVideoAuthorizationReceipt({
        receipt: input.receipt,
        viewerEName: input.viewerEName,
        streamId: input.streamId,
        env: this.authorizationEnv,
        now: binding.now,
      })
    ) {
      return undefined;
    }
    return binding;
  }

  /**
   * Cleanup is strictly maintenance: never make an authorized recovery wait
   * for it. The CTE selects at most a small batch, and the outer predicate is
   * repeated so a row refreshed between selection and delete cannot be lost.
   */
  private scheduleExpiredCleanup(nowMs: number): void {
    const state = cleanupStateFor(this.db);
    if (state.pending || state.nextAllowedAt > nowMs) return;
    state.nextAllowedAt = nowMs + playbackSourceRefreshCleanupIntervalMs;
    const now = new Date(nowMs);
    let pending: Promise<void>;
    pending = Promise.resolve()
      .then(() =>
        this.db.execute(sql`
        WITH expired_rows AS (
          SELECT ${playbackSourceRefreshEpochs.bindingHash} AS binding_hash
          FROM ${playbackSourceRefreshEpochs}
          WHERE ${playbackSourceRefreshEpochs.expiresAt} <= ${now}
          ORDER BY ${playbackSourceRefreshEpochs.expiresAt} ASC
          LIMIT ${maxExpiredPlaybackSourceRefreshRowsPerCleanup}
        )
        DELETE FROM ${playbackSourceRefreshEpochs}
        WHERE ${playbackSourceRefreshEpochs.bindingHash} IN (
          SELECT binding_hash FROM expired_rows
        )
        AND ${playbackSourceRefreshEpochs.expiresAt} <= ${now}
      `),
      )
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (state.pending === pending) state.pending = undefined;
      });
    state.pending = pending;
  }
}

function cleanupStateFor(database: W3dsDatabase): ExpiredCleanupState {
  let state = expiredCleanupStates.get(database);
  if (!state) {
    state = { nextAllowedAt: 0, pending: undefined };
    expiredCleanupStates.set(database, state);
  }
  return state;
}

export function createPlaybackSourceRefreshStore(
  database: W3dsDatabase = getPlaybackW3dsDatabase(),
  options: PlaybackSourceRefreshStoreOptions = {},
): PlaybackSourceRefreshStore {
  return new PostgresPlaybackSourceRefreshStore(database, options);
}

let defaultStore: PlaybackSourceRefreshStore | undefined;
let testStoreOverride: PlaybackSourceRefreshStore | undefined;

/** Test-only injection; production request paths always use the durable store. */
export function setPlaybackSourceRefreshStoreForTests(store?: PlaybackSourceRefreshStore): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Playback source-refresh stores may only be replaced in tests.');
  }
  testStoreOverride = store;
}

export function claimPlaybackSourceRefresh(
  input: PlaybackSourceRefreshClaimInput,
): Promise<PlaybackSourceRefreshClaim> {
  return resolveStore().claim(input);
}

export function publishPlaybackSourceRefresh(
  input: PublishPlaybackSourceRefreshInput,
): Promise<boolean> {
  return resolveStore().publish(input);
}

export function failPlaybackSourceRefresh(input: FailPlaybackSourceRefreshInput): Promise<boolean> {
  return resolveStore().fail(input);
}

export function readPlaybackSourceRefresh(
  input: PlaybackSourceRefreshReadInput,
): Promise<PlaybackSourceRefreshState> {
  return resolveStore().read(input);
}

function resolveStore(): PlaybackSourceRefreshStore {
  if (testStoreOverride) return testStoreOverride;
  defaultStore ??= createPlaybackSourceRefreshStore();
  return defaultStore;
}

function deriveKey(env: Record<string, string | undefined>, domain: string): Buffer {
  const secret = env.W3DS_AUTH_JWT_SECRET;
  if (!secret || secret.length < minimumSecretLength) {
    throw new PlaybackSourceRefreshConfigurationError();
  }
  return createHmac('sha256', secret).update(domain, 'utf8').digest();
}

function bindingHash(bindingKey: Buffer, viewerEName: string, streamId: string): string {
  return createHmac('sha256', bindingKey)
    .update(bindingDomain, 'utf8')
    .update('\u0000', 'utf8')
    .update(viewerEName, 'utf8')
    .update('\u0000', 'utf8')
    .update(streamId, 'utf8')
    .digest('base64url');
}

function hashLease(leaseKey: Buffer, token: string): string {
  return createHmac('sha256', leaseKey)
    .update(leaseDomain, 'utf8')
    .update('\u0000', 'utf8')
    .update(token, 'utf8')
    .digest('base64url');
}

function encryptPayload(
  mediaUrl: string,
  binding: string,
  epoch: number,
  encryptionKey: Buffer,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(payloadAad(binding, epoch));
  const plaintext = JSON.stringify({ mediaUrl });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    encryptedPayloadVersion,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function decryptPayload(
  value: string,
  binding: string,
  epoch: number,
  encryptionKey: Buffer,
): string | undefined {
  if (value.length > maxEncryptedPayloadLength) return undefined;
  const [version, ivValue, tagValue, ciphertextValue, ...rest] = value.split('.');
  if (
    version !== encryptedPayloadVersion ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue ||
    rest.length !== 0
  ) {
    return undefined;
  }
  try {
    const iv = strictBase64UrlDecode(ivValue);
    const tag = strictBase64UrlDecode(tagValue);
    const ciphertext = strictBase64UrlDecode(ciphertextValue);
    if (!iv || !tag || !ciphertext || iv.byteLength !== 12 || tag.byteLength !== 16) {
      return undefined;
    }
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAAD(payloadAad(binding, epoch));
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'mediaUrl')) return undefined;
    return normalizeSafeMediaUrl(record.mediaUrl);
  } catch {
    return undefined;
  }
}

function payloadAad(binding: string, epoch: number): Buffer {
  return Buffer.from(`${encryptionAadDomain}${binding}\u0000${epoch}`, 'utf8');
}

function normalizeSafeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > maxMediaUrlLength) return undefined;
  const url = parseSafePrivateMediaUpstreamUrl(value);
  if (!url || url.hash) return undefined;
  return url.toString();
}

function normalizeLease(value: PlaybackSourceRefreshLease): PlaybackSourceRefreshLease | undefined {
  if (
    !Number.isSafeInteger(value?.epoch) ||
    value.epoch < 1 ||
    typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.token) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt < 0 ||
    value.expiresAt > maxDateMs
  ) {
    return undefined;
  }
  return value;
}

function normalizeReplaceReadyEpoch(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function validViewerEName(value: unknown): string | undefined {
  return typeof value === 'string' && /^@[^\s@/]{1,255}$/.test(value) ? value : undefined;
}

function validOpaqueStreamId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,8192}$/.test(value) ? value : undefined;
}

function normalizeNow(value: number | undefined): number | undefined {
  const now = value ?? Date.now();
  return Number.isSafeInteger(now) && now >= 0 && now <= maxDateMs ? now : undefined;
}

/**
 * Production lease decisions must use the database's statement-time clock.
 * `clock_timestamp()` advances while a statement waits for locks or a pooled
 * connection; transaction-start `now()` would preserve the same stale-time
 * race this fence is intended to prevent. Tests intentionally pass a logical
 * timestamp and retain their deterministic clock semantics.
 */
function databaseTimestamp(input: PlaybackSourceRefreshBinding, fallback: Date) {
  return input.now === undefined ? sql`clock_timestamp()` : fallback;
}

function databaseTimestampAfter(
  input: PlaybackSourceRefreshBinding,
  fallback: Date,
  durationMs: number,
) {
  return input.now === undefined
    ? sql`clock_timestamp() + ${durationMs} * interval '1 millisecond'`
    : new Date(fallback.getTime() + durationMs);
}

function canAddTtl(now: number, ttlMs: number): boolean {
  return now <= maxDateMs - ttlMs;
}

function strictBase64UrlDecode(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength > 0 && decoded.toString('base64url') === value ? decoded : undefined;
}
