/// <reference path="./server-only-module.d.ts" />
import 'server-only';

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { and, eq, lte } from 'drizzle-orm';

import { getPlaybackW3dsDatabase, type W3dsDatabase } from './db/client';
import { eVaultMediaUrlCache as eVaultMediaUrlCacheTable } from './db/schema';
import {
  maxPrivateMediaUrlCacheTtlMs,
  parseSafePrivateMediaUpstreamUrl,
  resolvePrivateMediaUrlCacheExpiry,
} from './private-media-upstream';

const minimumSecretLength = 32;
const lookupKeyDomain = 'vidak.evault-media-url-cache.lookup-key.v2';
const lookupDomain = 'vidak.evault-media-url-cache.lookup.v2';
const encryptionKeyDomain = 'vidak.evault-media-url-cache.encryption-key.v2';
const encryptionAadDomain = 'vidak.evault-media-url-cache.payload.v2\u0000';
const encryptedPayloadVersion = 'v2';
const maxMediaUrlLength = 16_384;
const maxBindingLength = 16_384;
const maxGenerationLength = 128;
const maxEncryptedPayloadLength = 48_000;
const maxDateMs = 8_640_000_000_000_000;

/**
 * The eVault redirect cache never grants access and never outlives the source
 * URL's own expiry. This is only the maximum caller ceiling; URLs without a
 * portable expiry are retained for the short burst chosen by the media helper.
 */
export const maxEVaultMediaUrlCacheTtlMs = maxPrivateMediaUrlCacheTtlMs;

/**
 * A resolver has bounded source work (the File redirect and compatibility
 * read), but its write may finish after a rejected URL has been invalidated.
 * Keep the tombstone longer than that work. Its random durable generation is
 * then a cross-replica compare-and-swap fence for all late writes.
 */
export const eVaultMediaUrlCacheWriteFenceTtlMs = 2 * 60 * 1000;

export interface EVaultMediaUrlCacheBinding {
  /**
   * Server-only, complete viewer/source authorization context. It is HMACed
   * before persistence and never serialized to a browser or database column.
   */
  cacheKey: string;
  /** Injectable only for deterministic tests. Milliseconds since the epoch. */
  now?: number;
}

export interface EVaultMediaUrlCacheLookup {
  /**
   * Opaque durable CAS token. A caller receives it before eVault I/O and must
   * present it when publishing. It is not an authorization token and never
   * leaves server code.
   */
  writeToken: string;
  /** Present only when the canonical redirect remains safely cacheable. */
  mediaUrl?: string;
  /** The actual safe cache deadline, including expiry safety margin. */
  expiresAt?: number;
}

export interface PutEVaultMediaUrlCacheInput extends EVaultMediaUrlCacheBinding {
  /** Canonically resolved HTTPS URL from the owner's eVault. */
  mediaUrl: string;
  /** The exact durable CAS token returned by `get` or `invalidate`. */
  writeToken: string;
  /** Optional shorter caller ceiling, normally the remaining stream lifetime. */
  ttlMs?: number;
}

export interface EVaultMediaUrlCache {
  put(input: PutEVaultMediaUrlCacheInput): Promise<boolean>;
  /**
   * Returns a cache hit plus a token for a potential miss write. On a miss it
   * creates or reuses a payload-free durable row so a later invalidation can
   * fence this exact resolver before its source request finishes.
   */
  get(input: EVaultMediaUrlCacheBinding): Promise<EVaultMediaUrlCacheLookup | undefined>;
  /**
   * Replaces the generation and leaves a short durable tombstone. Returning
   * the new token lets an explicit source refresh publish its replacement.
   */
  invalidate(input: EVaultMediaUrlCacheBinding): Promise<EVaultMediaUrlCacheLookup | undefined>;
}

export interface EVaultMediaUrlCacheOptions {
  env?: Record<string, string | undefined>;
  encryptionKey?: Buffer;
}

interface BoundCacheKey {
  bindingHash: string;
  now: number;
}

interface EncryptedPayload {
  mediaUrl: string;
}

interface CacheState {
  generation: string;
  encryptedPayload?: string;
  mediaExpiresAt?: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Deliberately generic: cache configuration must not reveal source details. */
export class EVaultMediaUrlCacheConfigurationError extends Error {
  constructor() {
    super(
      `eVault media URL caching requires W3DS_AUTH_JWT_SECRET with at least ${minimumSecretLength} characters.`,
    );
  }
}

/**
 * PostgreSQL-backed cache for canonical eVault File redirects. It stores only
 * a HMAC binding, a random write fence, expiry timestamps, and AES-GCM
 * ciphertext—never eNames, File URIs, stream grants, receipts, or URLs.
 */
export class PostgresEVaultMediaUrlCache implements EVaultMediaUrlCache {
  private readonly authorizationEnv: Record<string, string | undefined>;
  private readonly lookupKey: Buffer;
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly db: W3dsDatabase,
    options: EVaultMediaUrlCacheOptions = {},
  ) {
    this.authorizationEnv = options.env ?? process.env;
    this.lookupKey = deriveKey(this.authorizationEnv, lookupKeyDomain);
    this.encryptionKey = Buffer.from(
      options.encryptionKey ?? deriveKey(this.authorizationEnv, encryptionKeyDomain),
    );
    if (this.encryptionKey.byteLength !== 32) throw new EVaultMediaUrlCacheConfigurationError();
  }

  async put(input: PutEVaultMediaUrlCacheInput): Promise<boolean> {
    const bound = this.bind(input);
    const writeToken = normalizeGeneration(input.writeToken);
    const expiry = bound ? cacheExpiry(input.mediaUrl, bound.now, input.ttlMs) : undefined;
    if (!bound || !writeToken || !expiry) return false;

    const now = new Date(bound.now);
    const mediaExpiresAt = new Date(expiry.expiresAt);
    const encryptedPayload = encryptPayload(
      expiry.mediaUrl,
      bound.bindingHash,
      writeToken,
      this.encryptionKey,
    );
    try {
      const rows = await this.db
        .update(eVaultMediaUrlCacheTable)
        .set({
          encryptedPayload,
          mediaExpiresAt,
          expiresAt: retentionExpiresAt(bound.now, expiry.expiresAt),
          updatedAt: now,
        })
        .where(
          and(
            eq(eVaultMediaUrlCacheTable.bindingHash, bound.bindingHash),
            eq(eVaultMediaUrlCacheTable.generation, writeToken),
          ),
        )
        .returning({ bindingHash: eVaultMediaUrlCacheTable.bindingHash });
      return rows.length === 1;
    } catch {
      return false;
    }
  }

  async get(input: EVaultMediaUrlCacheBinding): Promise<EVaultMediaUrlCacheLookup | undefined> {
    const bound = this.bind(input);
    if (!bound) return undefined;
    try {
      const row = await this.readOrCreate(bound);
      if (!row) return undefined;
      return await this.lookupFromRow(bound, row);
    } catch {
      return undefined;
    }
  }

  async invalidate(
    input: EVaultMediaUrlCacheBinding,
  ): Promise<EVaultMediaUrlCacheLookup | undefined> {
    const bound = this.bind(input);
    if (!bound) return undefined;
    try {
      return await this.replaceWithTombstone(bound);
    } catch {
      return undefined;
    }
  }

  private async readOrCreate(bound: BoundCacheKey): Promise<CacheState | undefined> {
    const now = new Date(bound.now);
    const [existing] = await this.db
      .select()
      .from(eVaultMediaUrlCacheTable)
      .where(eq(eVaultMediaUrlCacheTable.bindingHash, bound.bindingHash))
      .limit(1);
    if (existing && existing.expiresAt.getTime() > bound.now) return cacheStateFromRow(existing);
    if (existing) {
      // A conditional delete cannot remove a refreshed row if a concurrent
      // resolver or invalidation extended retention after our initial read.
      await this.db
        .delete(eVaultMediaUrlCacheTable)
        .where(
          and(
            eq(eVaultMediaUrlCacheTable.bindingHash, bound.bindingHash),
            lte(eVaultMediaUrlCacheTable.expiresAt, now),
          ),
        );
    }

    const generation = newGeneration();
    const [created] = await this.db
      .insert(eVaultMediaUrlCacheTable)
      .values({
        bindingHash: bound.bindingHash,
        generation,
        encryptedPayload: null,
        mediaExpiresAt: null,
        expiresAt: retentionExpiresAt(bound.now),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return cacheStateFromRow(created);

    // Another replica won the insert. Its random generation is now the only
    // valid write token; an old resolver can never substitute its payload.
    const [reread] = await this.db
      .select()
      .from(eVaultMediaUrlCacheTable)
      .where(eq(eVaultMediaUrlCacheTable.bindingHash, bound.bindingHash))
      .limit(1);
    return reread && reread.expiresAt.getTime() > bound.now ? cacheStateFromRow(reread) : undefined;
  }

  private async lookupFromRow(
    bound: BoundCacheKey,
    row: CacheState,
  ): Promise<EVaultMediaUrlCacheLookup | undefined> {
    if (!normalizeGeneration(row.generation)) return this.replaceWithTombstone(bound);
    const lookup: EVaultMediaUrlCacheLookup = { writeToken: row.generation };
    if (!row.encryptedPayload || !row.mediaExpiresAt || row.mediaExpiresAt <= bound.now)
      return lookup;
    const mediaUrl = decryptPayload(
      row.encryptedPayload,
      bound.bindingHash,
      row.generation,
      this.encryptionKey,
    );
    if (!mediaUrl) return this.replaceWithTombstone(bound);
    return { ...lookup, mediaUrl, expiresAt: row.mediaExpiresAt };
  }

  private async replaceWithTombstone(
    bound: BoundCacheKey,
  ): Promise<EVaultMediaUrlCacheLookup | undefined> {
    const now = new Date(bound.now);
    const generation = newGeneration();
    const [row] = await this.db
      .insert(eVaultMediaUrlCacheTable)
      .values({
        bindingHash: bound.bindingHash,
        generation,
        encryptedPayload: null,
        mediaExpiresAt: null,
        expiresAt: retentionExpiresAt(bound.now),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: eVaultMediaUrlCacheTable.bindingHash,
        set: {
          generation,
          encryptedPayload: null,
          mediaExpiresAt: null,
          expiresAt: retentionExpiresAt(bound.now),
          updatedAt: now,
        },
      })
      .returning({ generation: eVaultMediaUrlCacheTable.generation });
    return row?.generation === generation ? { writeToken: generation } : undefined;
  }

  private bind(input: EVaultMediaUrlCacheBinding): BoundCacheKey | undefined {
    const now = normalizeNow(input.now);
    if (now === undefined || !isValidCacheKey(input.cacheKey)) return undefined;
    return { bindingHash: bindingHash(this.lookupKey, input.cacheKey), now };
  }
}

/** Test-only implementation with the same generation and expiry semantics. */
export class InMemoryEVaultMediaUrlCache implements EVaultMediaUrlCache {
  private readonly lookupKey: Buffer;
  private readonly encryptionKey: Buffer;
  private readonly entries = new Map<string, CacheState>();

  constructor(options: EVaultMediaUrlCacheOptions = {}) {
    const env = options.env ?? process.env;
    this.lookupKey = deriveKey(env, lookupKeyDomain);
    this.encryptionKey = Buffer.from(options.encryptionKey ?? deriveKey(env, encryptionKeyDomain));
    if (this.encryptionKey.byteLength !== 32) throw new EVaultMediaUrlCacheConfigurationError();
  }

  async put(input: PutEVaultMediaUrlCacheInput): Promise<boolean> {
    const bound = this.bind(input);
    const writeToken = normalizeGeneration(input.writeToken);
    const expiry = bound ? cacheExpiry(input.mediaUrl, bound.now, input.ttlMs) : undefined;
    if (!bound || !writeToken || !expiry) return false;
    this.pruneExpired(bound.now);
    const existing = this.entries.get(bound.bindingHash);
    if (!existing || existing.generation !== writeToken) return false;
    this.entries.set(bound.bindingHash, {
      ...existing,
      encryptedPayload: encryptPayload(
        expiry.mediaUrl,
        bound.bindingHash,
        writeToken,
        this.encryptionKey,
      ),
      mediaExpiresAt: expiry.expiresAt,
      expiresAt: retentionExpiryMs(bound.now, expiry.expiresAt),
      updatedAt: bound.now,
    });
    return true;
  }

  async get(input: EVaultMediaUrlCacheBinding): Promise<EVaultMediaUrlCacheLookup | undefined> {
    const bound = this.bind(input);
    if (!bound) return undefined;
    this.pruneExpired(bound.now);
    const state = this.ensure(bound);
    const lookup: EVaultMediaUrlCacheLookup = { writeToken: state.generation };
    if (!state.encryptedPayload || !state.mediaExpiresAt || state.mediaExpiresAt <= bound.now) {
      return lookup;
    }
    const mediaUrl = decryptPayload(
      state.encryptedPayload,
      bound.bindingHash,
      state.generation,
      this.encryptionKey,
    );
    if (!mediaUrl) return this.replaceWithTombstone(bound);
    return { ...lookup, mediaUrl, expiresAt: state.mediaExpiresAt };
  }

  async invalidate(
    input: EVaultMediaUrlCacheBinding,
  ): Promise<EVaultMediaUrlCacheLookup | undefined> {
    const bound = this.bind(input);
    if (!bound) return undefined;
    this.pruneExpired(bound.now);
    return this.replaceWithTombstone(bound);
  }

  private ensure(bound: BoundCacheKey): CacheState {
    let state = this.entries.get(bound.bindingHash);
    if (state) return state;
    state = {
      generation: newGeneration(),
      expiresAt: retentionExpiryMs(bound.now),
      createdAt: bound.now,
      updatedAt: bound.now,
    };
    this.entries.set(bound.bindingHash, state);
    return state;
  }

  private replaceWithTombstone(bound: BoundCacheKey): EVaultMediaUrlCacheLookup {
    const previous = this.entries.get(bound.bindingHash);
    const generation = newGeneration();
    this.entries.set(bound.bindingHash, {
      generation,
      expiresAt: retentionExpiryMs(bound.now),
      createdAt: previous?.createdAt ?? bound.now,
      updatedAt: bound.now,
    });
    return { writeToken: generation };
  }

  private bind(input: EVaultMediaUrlCacheBinding): BoundCacheKey | undefined {
    const now = normalizeNow(input.now);
    if (now === undefined || !isValidCacheKey(input.cacheKey)) return undefined;
    return { bindingHash: bindingHash(this.lookupKey, input.cacheKey), now };
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export function createEVaultMediaUrlCache(
  database: W3dsDatabase = getPlaybackW3dsDatabase(),
  options: EVaultMediaUrlCacheOptions = {},
): EVaultMediaUrlCache {
  return new PostgresEVaultMediaUrlCache(database, options);
}

let defaultCache: EVaultMediaUrlCache | undefined;
let testCacheOverride: EVaultMediaUrlCache | undefined;

/** Test-only injection; production always uses the PostgreSQL implementation. */
export function setEVaultMediaUrlCacheForTests(cache?: EVaultMediaUrlCache): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('eVault media URL caches may only be replaced in tests.');
  }
  testCacheOverride = cache;
}

/**
 * A cache fault is always a miss. The foreground resolver must continue with
 * the regular, authenticated eVault File lookup rather than fail playback.
 */
export async function getEVaultMediaUrlCache(
  input: EVaultMediaUrlCacheBinding,
): Promise<EVaultMediaUrlCacheLookup | undefined> {
  try {
    return await resolveCache().get(input);
  } catch {
    return undefined;
  }
}

/** Best-effort CAS write after a canonical File read. */
export async function putEVaultMediaUrlCache(input: PutEVaultMediaUrlCacheInput): Promise<boolean> {
  try {
    return await resolveCache().put(input);
  } catch {
    return false;
  }
}

/**
 * Fences an exact binding before source recovery. It intentionally retains a
 * payload-free tombstone, not a delete, so an older in-flight resolver cannot
 * resurrect the rejected signed redirect after this call returns.
 */
export async function invalidateEVaultMediaUrlCache(
  input: EVaultMediaUrlCacheBinding,
): Promise<EVaultMediaUrlCacheLookup | undefined> {
  try {
    return await resolveCache().invalidate(input);
  } catch {
    return undefined;
  }
}

function resolveCache(): EVaultMediaUrlCache {
  if (testCacheOverride) return testCacheOverride;
  defaultCache ??= createEVaultMediaUrlCache();
  return defaultCache;
}

function deriveKey(env: Record<string, string | undefined>, domain: string): Buffer {
  const secret = env.W3DS_AUTH_JWT_SECRET;
  if (!secret || secret.length < minimumSecretLength) {
    throw new EVaultMediaUrlCacheConfigurationError();
  }
  return createHmac('sha256', secret).update(domain, 'utf8').digest();
}

function bindingHash(lookupKey: Buffer, cacheKey: string): string {
  return createHmac('sha256', lookupKey)
    .update(lookupDomain, 'utf8')
    .update('\u0000', 'utf8')
    .update(cacheKey, 'utf8')
    .digest('base64url');
}

function encryptPayload(
  mediaUrl: string,
  bindingHashValue: string,
  generation: string,
  encryptionKey: Buffer,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(payloadAad(bindingHashValue, generation));
  const plaintext = JSON.stringify({ mediaUrl } satisfies EncryptedPayload);
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
  bindingHashValue: string,
  generation: string,
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
    decipher.setAAD(payloadAad(bindingHashValue, generation));
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

function payloadAad(bindingHashValue: string, generation: string): Buffer {
  return Buffer.from(`${encryptionAadDomain}${bindingHashValue}\u0000${generation}`, 'utf8');
}

function cacheExpiry(
  mediaUrl: string,
  now: number,
  ttlMs: number | undefined,
): { mediaUrl: string; expiresAt: number } | undefined {
  const safeUrl = normalizeSafeMediaUrl(mediaUrl);
  const maxTtlMs = normalizeTtl(ttlMs);
  if (!safeUrl || maxTtlMs === undefined || !canAddTtl(now, maxTtlMs)) return undefined;
  const resolved = resolvePrivateMediaUrlCacheExpiry(safeUrl, { now, maxTtlMs });
  // A durable entry can outlive this Node process. Only persist a redirect
  // whose provider exposes a portable, explicit expiration. Unknown signed
  // URLs are intentionally handled by the caller's short process-local burst
  // cache; retaining them in Postgres would turn an unobservable source TTL
  // into a later, user-visible playback failure.
  if (resolved?.kind !== 'explicit' || !canAddTtl(now, resolved.ttlMs)) {
    return undefined;
  }
  return { mediaUrl: safeUrl, expiresAt: now + resolved.ttlMs };
}

function cacheStateFromRow(row: typeof eVaultMediaUrlCacheTable.$inferSelect): CacheState {
  return {
    generation: row.generation,
    ...(row.encryptedPayload ? { encryptedPayload: row.encryptedPayload } : {}),
    ...(row.mediaExpiresAt ? { mediaExpiresAt: row.mediaExpiresAt.getTime() } : {}),
    expiresAt: row.expiresAt.getTime(),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function retentionExpiresAt(now: number, mediaExpiresAt?: number): Date {
  return new Date(retentionExpiryMs(now, mediaExpiresAt));
}

function retentionExpiryMs(now: number, mediaExpiresAt?: number): number {
  const fenceExpiry = canAddTtl(now, eVaultMediaUrlCacheWriteFenceTtlMs)
    ? now + eVaultMediaUrlCacheWriteFenceTtlMs
    : maxDateMs;
  return Math.max(mediaExpiresAt ?? 0, fenceExpiry);
}

function newGeneration(): string {
  return randomBytes(24).toString('base64url');
}

function normalizeGeneration(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= maxGenerationLength &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : undefined;
}

function strictBase64UrlDecode(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength > 0 && decoded.toString('base64url') === value ? decoded : undefined;
}

function normalizeSafeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > maxMediaUrlLength) return undefined;
  const url = parseSafePrivateMediaUpstreamUrl(value);
  if (!url || url.hash) return undefined;
  return url.toString();
}

function isValidCacheKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBindingLength;
}

function normalizeNow(value: number | undefined): number | undefined {
  const now = value ?? Date.now();
  return Number.isSafeInteger(now) && now >= 0 && now <= maxDateMs ? now : undefined;
}

function normalizeTtl(value: number | undefined): number | undefined {
  if (value === undefined) return maxEVaultMediaUrlCacheTtlMs;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(maxEVaultMediaUrlCacheTtlMs, Math.floor(value));
}

function canAddTtl(now: number, ttlMs: number): boolean {
  return now <= maxDateMs - ttlMs;
}
