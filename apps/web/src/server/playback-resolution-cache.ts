/// <reference path="./server-only-module.d.ts" />
import 'server-only';

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';

import { getW3dsDatabase, type W3dsDatabase } from './db/client';
import { playbackResolutionCache } from './db/schema';
import { parseSafePrivateMediaUpstreamUrl } from './private-media-upstream';
import {
  sharedVideoAuthorizationReceiptTtlMs,
  verifySharedVideoAuthorizationReceipt,
} from './shared-video-authorization-receipt';

const minimumSecretLength = 32;
const receiptLookupKeyDomain = 'vidak.playback-resolution-cache.lookup-key.v1';
const receiptLookupDomain = 'vidak.playback-resolution-cache.lookup.v1';
const encryptionKeyDomain = 'vidak.playback-resolution-cache.encryption-key.v1';
const encryptionAadDomain = 'vidak.playback-resolution-cache.payload.v1\u0000';
const encryptedPayloadVersion = 'v1';
const maxMediaUrlLength = 16_384;
const maxEncryptedPayloadLength = 48_000;
const maxDateMs = 8_640_000_000_000_000;

/**
 * This cache must never outlive the signed receipt that binds it to a viewer
 * and stream. It is an optimization, not a durable authorization decision.
 */
export const maxPlaybackResolutionCacheTtlMs = sharedVideoAuthorizationReceiptTtlMs;

export interface PlaybackResolutionCacheBinding {
  /** Opaque signed receipt. It is validated but never persisted. */
  receipt: string | null | undefined;
  /** Exact authenticated viewer that the receipt was minted for. */
  viewerEName: string;
  /** Exact sealed stream grant that the receipt was minted for. */
  streamId: string;
  /** Injectable only for deterministic tests. Milliseconds since the epoch. */
  now?: number;
}

export interface PutPlaybackResolutionCacheInput extends PlaybackResolutionCacheBinding {
  /** Server-resolved URL. It must be a syntactically safe HTTPS upstream. */
  mediaUrl: string;
  /** Optional shorter expiry; values above the receipt lifetime are clamped. */
  ttlMs?: number;
}

/**
 * Server-only persistence boundary. Every operation takes the full receipt
 * binding so a caller cannot accidentally treat a cache hit as a standalone
 * playback grant.
 */
export interface PlaybackResolutionCache {
  put(input: PutPlaybackResolutionCacheInput): Promise<boolean>;
  get(input: PlaybackResolutionCacheBinding): Promise<string | undefined>;
  delete(input: PlaybackResolutionCacheBinding): Promise<boolean>;
}

export interface PlaybackResolutionCacheOptions {
  /** Injectable only for deterministic tests. Production defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injectable only for isolated tests; production derives from the W3DS secret. */
  encryptionKey?: Buffer;
}

interface AuthorizedBinding {
  receiptHash: string;
  now: number;
}

interface EncryptedPlaybackResolutionPayload {
  mediaUrl: string;
}

/**
 * Deliberately generic: neither a receipt nor a media URL should appear in
 * configuration errors, logs, tracing, or browser responses.
 */
export class PlaybackResolutionCacheConfigurationError extends Error {
  constructor() {
    super(
      `Playback-resolution caching requires W3DS_AUTH_JWT_SECRET with at least ${minimumSecretLength} characters.`,
    );
  }
}

/**
 * Durable production implementation. It has no process-local fallback so a
 * cache written by one replica can be read by another without copying bytes
 * into the application or loosening viewer-bound authorization.
 */
export class PostgresPlaybackResolutionCache implements PlaybackResolutionCache {
  private readonly authorizationEnv: Record<string, string | undefined>;
  private readonly lookupKey: Buffer;
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly db: W3dsDatabase,
    options: PlaybackResolutionCacheOptions = {},
  ) {
    this.authorizationEnv = options.env ?? process.env;
    this.lookupKey = resolvePlaybackResolutionCacheLookupKey(this.authorizationEnv);
    this.encryptionKey = Buffer.from(
      options.encryptionKey ?? resolvePlaybackResolutionCacheEncryptionKey(this.authorizationEnv),
    );
    if (this.encryptionKey.byteLength !== 32) {
      throw new PlaybackResolutionCacheConfigurationError();
    }
  }

  async put(input: PutPlaybackResolutionCacheInput): Promise<boolean> {
    const authorized = this.authorize(input);
    const mediaUrl = normalizeSafeMediaUrl(input.mediaUrl);
    const ttlMs = normalizeTtl(input.ttlMs);
    if (!authorized || !mediaUrl || ttlMs === undefined || !canAddTtl(authorized.now, ttlMs)) {
      return false;
    }

    const now = new Date(authorized.now);
    const expiresAt = new Date(authorized.now + ttlMs);
    const encryptedPayload = encryptPayload(mediaUrl, authorized.receiptHash, this.encryptionKey);
    try {
      await this.db.transaction(async (tx) => {
        // Opportunistic bounded cleanup keeps this ephemeral table from
        // accumulating rows while never deleting a concurrent fresh write.
        await tx.delete(playbackResolutionCache).where(lte(playbackResolutionCache.expiresAt, now));
        await tx
          .insert(playbackResolutionCache)
          .values({
            receiptHash: authorized.receiptHash,
            encryptedPayload,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: playbackResolutionCache.receiptHash,
            set: { encryptedPayload, expiresAt, updatedAt: now },
          });
      });
      return true;
    } catch {
      // A cache miss is safe: the caller must repeat normal authorization and
      // source resolution. Never leak a DB or encrypted-row detail here.
      return false;
    }
  }

  async get(input: PlaybackResolutionCacheBinding): Promise<string | undefined> {
    const authorized = this.authorize(input);
    if (!authorized) return undefined;

    const now = new Date(authorized.now);
    try {
      const [row] = await this.db
        .select()
        .from(playbackResolutionCache)
        .where(eq(playbackResolutionCache.receiptHash, authorized.receiptHash))
        .limit(1);
      if (!row) return undefined;
      if (row.expiresAt.getTime() <= authorized.now) {
        await this.db
          .delete(playbackResolutionCache)
          .where(
            and(
              eq(playbackResolutionCache.receiptHash, authorized.receiptHash),
              lte(playbackResolutionCache.expiresAt, now),
            ),
          );
        return undefined;
      }

      const mediaUrl = decryptPayload(
        row.encryptedPayload,
        authorized.receiptHash,
        this.encryptionKey,
      );
      if (mediaUrl) return mediaUrl;

      // Delete only the exact corrupt ciphertext we observed. A concurrent
      // resolver may have replaced it between our read and cleanup.
      await this.db
        .delete(playbackResolutionCache)
        .where(
          and(
            eq(playbackResolutionCache.receiptHash, authorized.receiptHash),
            eq(playbackResolutionCache.encryptedPayload, row.encryptedPayload),
          ),
        );
      return undefined;
    } catch {
      // Fail closed: a datastore fault never turns this optimization into a
      // grant, and the caller can use its normal authorized resolution path.
      return undefined;
    }
  }

  async delete(input: PlaybackResolutionCacheBinding): Promise<boolean> {
    const authorized = this.authorize(input);
    if (!authorized) return false;
    try {
      const rows = await this.db
        .delete(playbackResolutionCache)
        .where(eq(playbackResolutionCache.receiptHash, authorized.receiptHash))
        .returning({ receiptHash: playbackResolutionCache.receiptHash });
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  private authorize(input: PlaybackResolutionCacheBinding): AuthorizedBinding | undefined {
    const now = normalizeNow(input.now);
    if (now === undefined || typeof input.receipt !== 'string') return undefined;
    if (
      !verifySharedVideoAuthorizationReceipt({
        receipt: input.receipt,
        viewerEName: input.viewerEName,
        streamId: input.streamId,
        env: this.authorizationEnv,
        now,
      })
    ) {
      return undefined;
    }
    return { receiptHash: receiptHash(this.lookupKey, input.receipt), now };
  }
}

/**
 * Test-only isolated implementation. It stores the same encrypted row shape
 * as PostgreSQL but is never selected by production request paths.
 */
export class InMemoryPlaybackResolutionCache implements PlaybackResolutionCache {
  private readonly authorizationEnv: Record<string, string | undefined>;
  private readonly lookupKey: Buffer;
  private readonly encryptionKey: Buffer;
  private readonly entries = new Map<
    string,
    { encryptedPayload: string; expiresAt: number; createdAt: number; updatedAt: number }
  >();

  constructor(options: PlaybackResolutionCacheOptions = {}) {
    this.authorizationEnv = options.env ?? process.env;
    this.lookupKey = resolvePlaybackResolutionCacheLookupKey(this.authorizationEnv);
    this.encryptionKey = Buffer.from(
      options.encryptionKey ?? resolvePlaybackResolutionCacheEncryptionKey(this.authorizationEnv),
    );
    if (this.encryptionKey.byteLength !== 32) {
      throw new PlaybackResolutionCacheConfigurationError();
    }
  }

  async put(input: PutPlaybackResolutionCacheInput): Promise<boolean> {
    const authorized = this.authorize(input);
    const mediaUrl = normalizeSafeMediaUrl(input.mediaUrl);
    const ttlMs = normalizeTtl(input.ttlMs);
    if (!authorized || !mediaUrl || ttlMs === undefined || !canAddTtl(authorized.now, ttlMs)) {
      return false;
    }
    this.pruneExpired(authorized.now);
    const encryptedPayload = encryptPayload(mediaUrl, authorized.receiptHash, this.encryptionKey);
    const existing = this.entries.get(authorized.receiptHash);
    this.entries.set(authorized.receiptHash, {
      encryptedPayload,
      expiresAt: authorized.now + ttlMs,
      createdAt: existing?.createdAt ?? authorized.now,
      updatedAt: authorized.now,
    });
    return true;
  }

  async get(input: PlaybackResolutionCacheBinding): Promise<string | undefined> {
    const authorized = this.authorize(input);
    if (!authorized) return undefined;
    this.pruneExpired(authorized.now);
    const row = this.entries.get(authorized.receiptHash);
    if (!row) return undefined;
    const mediaUrl = decryptPayload(
      row.encryptedPayload,
      authorized.receiptHash,
      this.encryptionKey,
    );
    if (mediaUrl) return mediaUrl;
    this.entries.delete(authorized.receiptHash);
    return undefined;
  }

  async delete(input: PlaybackResolutionCacheBinding): Promise<boolean> {
    const authorized = this.authorize(input);
    if (!authorized) return false;
    this.pruneExpired(authorized.now);
    return this.entries.delete(authorized.receiptHash);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  private authorize(input: PlaybackResolutionCacheBinding): AuthorizedBinding | undefined {
    const now = normalizeNow(input.now);
    if (now === undefined || typeof input.receipt !== 'string') return undefined;
    if (
      !verifySharedVideoAuthorizationReceipt({
        receipt: input.receipt,
        viewerEName: input.viewerEName,
        streamId: input.streamId,
        env: this.authorizationEnv,
        now,
      })
    ) {
      return undefined;
    }
    return { receiptHash: receiptHash(this.lookupKey, input.receipt), now };
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

/** Production factory: PostgreSQL only, with shared key derivation on every replica. */
export function createPlaybackResolutionCache(
  database: W3dsDatabase = getW3dsDatabase(),
  options: PlaybackResolutionCacheOptions = {},
): PlaybackResolutionCache {
  return new PostgresPlaybackResolutionCache(database, options);
}

let defaultCache: PlaybackResolutionCache | undefined;
let testCacheOverride: PlaybackResolutionCache | undefined;

/**
 * Test-only injection. Production callers always resolve the durable
 * PostgreSQL implementation above, never a process-local map.
 */
export function setPlaybackResolutionCacheForTests(cache?: PlaybackResolutionCache): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Playback-resolution caches may only be replaced in tests.');
  }
  testCacheOverride = cache;
}

/** Writes an encrypted, receipt-bound source resolution, or safely declines it. */
export async function putPlaybackResolutionCache(
  input: PutPlaybackResolutionCacheInput,
): Promise<boolean> {
  return resolveCache().put(input);
}

/** Reads a source only after rechecking the receipt, viewer, and stream binding. */
export async function getPlaybackResolutionCache(
  input: PlaybackResolutionCacheBinding,
): Promise<string | undefined> {
  return resolveCache().get(input);
}

/** Removes a source only after rechecking the receipt, viewer, and stream binding. */
export async function deletePlaybackResolutionCache(
  input: PlaybackResolutionCacheBinding,
): Promise<boolean> {
  return resolveCache().delete(input);
}

/**
 * Shared 256-bit AES key, domain-separated from all other W3DS uses. The
 * same secret produces the same key on every replica without adding a second
 * deployment secret that could drift between pods.
 */
export function resolvePlaybackResolutionCacheEncryptionKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  return deriveKey(env, encryptionKeyDomain);
}

function resolveCache(): PlaybackResolutionCache {
  if (testCacheOverride) return testCacheOverride;
  defaultCache ??= createPlaybackResolutionCache();
  return defaultCache;
}

function resolvePlaybackResolutionCacheLookupKey(env: Record<string, string | undefined>): Buffer {
  return deriveKey(env, receiptLookupKeyDomain);
}

function deriveKey(env: Record<string, string | undefined>, domain: string): Buffer {
  const secret = env.W3DS_AUTH_JWT_SECRET;
  if (!secret || secret.length < minimumSecretLength) {
    throw new PlaybackResolutionCacheConfigurationError();
  }
  return createHmac('sha256', secret).update(domain, 'utf8').digest();
}

function receiptHash(lookupKey: Buffer, receipt: string): string {
  return createHmac('sha256', lookupKey)
    .update(receiptLookupDomain, 'utf8')
    .update('\u0000', 'utf8')
    .update(receipt, 'utf8')
    .digest('base64url');
}

function encryptPayload(mediaUrl: string, key: string, encryptionKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(payloadAad(key));
  const plaintext = JSON.stringify({ mediaUrl } satisfies EncryptedPlaybackResolutionPayload);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    encryptedPayloadVersion,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function decryptPayload(value: string, key: string, encryptionKey: Buffer): string | undefined {
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
    decipher.setAAD(payloadAad(key));
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
    ) as unknown;
    return parseEncryptedPayload(parsed);
  } catch {
    return undefined;
  }
}

function parseEncryptedPayload(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'mediaUrl')) return undefined;
  return normalizeSafeMediaUrl(payload.mediaUrl);
}

function payloadAad(receiptHash: string): Buffer {
  return Buffer.from(`${encryptionAadDomain}${receiptHash}`, 'utf8');
}

function strictBase64UrlDecode(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength > 0 && decoded.toString('base64url') === value ? decoded : undefined;
}

function normalizeSafeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > maxMediaUrlLength) return undefined;
  const url = parseSafePrivateMediaUpstreamUrl(value);
  // Fragments are never sent upstream and cannot affect media retrieval;
  // reject them rather than treating differently spelled URLs as cacheable.
  if (!url || url.hash) return undefined;
  return url.toString();
}

function normalizeNow(value: number | undefined): number | undefined {
  const now = value ?? Date.now();
  return Number.isSafeInteger(now) && now >= 0 && now <= maxDateMs ? now : undefined;
}

function normalizeTtl(value: number | undefined): number | undefined {
  if (value === undefined) return maxPlaybackResolutionCacheTtlMs;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(maxPlaybackResolutionCacheTtlMs, Math.floor(value));
}

function canAddTtl(now: number, ttlMs: number): boolean {
  return now <= maxDateMs - ttlMs;
}
