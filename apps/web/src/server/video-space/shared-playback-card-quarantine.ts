import 'server-only';

import { and, eq, gt, inArray } from 'drizzle-orm';
import { getPlaybackW3dsDatabase, type W3dsDatabase } from '../db/client';
import { sharedPlaybackCardQuarantines } from '../db/schema';

/**
 * A denied card remains hidden long enough to stop a stale inventory from
 * repeatedly sending a viewer to an access failure. It is not permanent: a
 * later current share can use a different stable source context, and a truly
 * restored identical context eventually reappears for a new live proof.
 */
export const sharedPlaybackCardQuarantineTtlMs = 24 * 60 * 60 * 1_000;
const maxBindingsPerLookup = 2_048;
const bindingHashPattern = /^[A-Za-z0-9_-]{43}$/;

export interface SharedPlaybackCardQuarantineStore {
  /** Records one confirmed terminal live shared-playback denial. */
  record(bindingHash: string): Promise<boolean>;
  /** Returns only currently active hashes from the supplied opaque batch. */
  matching(bindingHashes: readonly string[]): Promise<ReadonlySet<string>>;
  /** Clears a tombstone after a future authoritative success for this context. */
  clear(bindingHash: string): Promise<boolean>;
}

export interface SharedPlaybackCardQuarantineStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

function normalizeBindingHash(value: string): string | undefined {
  return bindingHashPattern.test(value) ? value : undefined;
}

function normalizedBindings(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map(normalizeBindingHash)
        .filter((value): value is string => value !== undefined)
        .slice(0, maxBindingsPerLookup),
    ),
  ];
}

/** In-memory implementation for deterministic tests and immediate local visibility. */
export class InMemorySharedPlaybackCardQuarantineStore
  implements SharedPlaybackCardQuarantineStore
{
  private readonly entries = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: SharedPlaybackCardQuarantineStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? sharedPlaybackCardQuarantineTtlMs;
  }

  async record(bindingHash: string): Promise<boolean> {
    const hash = normalizeBindingHash(bindingHash);
    if (!hash) return false;
    this.prune();
    this.entries.set(hash, this.now() + this.ttlMs);
    return true;
  }

  async matching(bindingHashes: readonly string[]): Promise<ReadonlySet<string>> {
    this.prune();
    return new Set(normalizedBindings(bindingHashes).filter((hash) => this.entries.has(hash)));
  }

  async clear(bindingHash: string): Promise<boolean> {
    const hash = normalizeBindingHash(bindingHash);
    return hash ? this.entries.delete(hash) : false;
  }

  /** Mirrors a durable expiry without extending it from the current clock. */
  hydrate(bindingHash: string, expiresAt: number): boolean {
    const hash = normalizeBindingHash(bindingHash);
    if (!hash || !Number.isFinite(expiresAt) || expiresAt <= this.now()) return false;
    this.entries.set(hash, expiresAt);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [hash, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(hash);
    }
  }
}

/**
 * Production store. A short in-process mirror gives the triggering request
 * immediate consistency; Postgres makes the privacy-safe tombstone durable
 * across workers. Database faults deliberately fail open for visibility—the
 * independent playback ACL remains fail-closed.
 */
export class PostgresSharedPlaybackCardQuarantineStore
  implements SharedPlaybackCardQuarantineStore
{
  private readonly local: InMemorySharedPlaybackCardQuarantineStore;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly db: W3dsDatabase,
    options: SharedPlaybackCardQuarantineStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? sharedPlaybackCardQuarantineTtlMs;
    this.local = new InMemorySharedPlaybackCardQuarantineStore({
      now: this.now,
      ttlMs: this.ttlMs,
    });
  }

  async record(bindingHash: string): Promise<boolean> {
    const hash = normalizeBindingHash(bindingHash);
    if (!hash) return false;
    // Preserve immediate local suppression even when a best-effort durable
    // write is temporarily unavailable.
    await this.local.record(hash);
    const now = new Date(this.now());
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    try {
      await this.db
        .insert(sharedPlaybackCardQuarantines)
        .values({ bindingHash: hash, expiresAt, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: sharedPlaybackCardQuarantines.bindingHash,
          set: { expiresAt, updatedAt: now },
        });
      return true;
    } catch {
      return false;
    }
  }

  async matching(bindingHashes: readonly string[]): Promise<ReadonlySet<string>> {
    const hashes = normalizedBindings(bindingHashes);
    if (hashes.length === 0) return new Set();
    const matches = new Set(await this.local.matching(hashes));
    const now = new Date(this.now());
    try {
      const rows = await this.db
        .select({
          bindingHash: sharedPlaybackCardQuarantines.bindingHash,
          expiresAt: sharedPlaybackCardQuarantines.expiresAt,
        })
        .from(sharedPlaybackCardQuarantines)
        .where(
          and(
            inArray(sharedPlaybackCardQuarantines.bindingHash, hashes),
            gt(sharedPlaybackCardQuarantines.expiresAt, now),
          ),
        );
      for (const row of rows) {
        matches.add(row.bindingHash);
        this.local.hydrate(row.bindingHash, row.expiresAt.getTime());
      }
    } catch {
      // A visibility cache outage must never alter the normal catalogue or
      // authorization outcome. Keep the immediate local hits only.
    }
    return matches;
  }

  async clear(bindingHash: string): Promise<boolean> {
    const hash = normalizeBindingHash(bindingHash);
    if (!hash) return false;
    await this.local.clear(hash);
    try {
      await this.db
        .delete(sharedPlaybackCardQuarantines)
        .where(eq(sharedPlaybackCardQuarantines.bindingHash, hash));
      return true;
    } catch {
      return false;
    }
  }
}

let singleton: SharedPlaybackCardQuarantineStore | undefined;
let storeForTests: SharedPlaybackCardQuarantineStore | undefined;

export function getSharedPlaybackCardQuarantineStore(): SharedPlaybackCardQuarantineStore {
  if (storeForTests) return storeForTests;
  singleton ??= new PostgresSharedPlaybackCardQuarantineStore(getPlaybackW3dsDatabase());
  return singleton;
}

/** Test-only injection; production uses the dedicated playback database pool. */
export function setSharedPlaybackCardQuarantineStoreForTests(
  store: SharedPlaybackCardQuarantineStore | undefined,
): void {
  storeForTests = store;
  singleton = undefined;
}

/**
 * Returns the private marker only when the caller hands us a real typed
 * authorization failure. It intentionally does not infer terminal denial
 * from a public code alone: unrelated upstream 401/403 responses can share
 * that code and must never hide a card.
 */
export function confirmedSharedPlaybackCardBindingHash(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    code?: unknown;
    terminalSharedCardBindingHash?: unknown;
  };
  if (candidate.code !== 'authorization_denied') return undefined;
  return typeof candidate.terminalSharedCardBindingHash === 'string'
    ? normalizeBindingHash(candidate.terminalSharedCardBindingHash)
    : undefined;
}

/**
 * Best-effort route helper. It is invoked only from interactive playback
 * endpoints after the normal source attempt ends in the typed terminal marker.
 */
export function recordConfirmedSharedPlaybackDenial(error: unknown): void {
  const bindingHash = confirmedSharedPlaybackCardBindingHash(error);
  if (!bindingHash) return;
  try {
    // Start immediately so this process's in-memory mirror can hide the card
    // on the very next catalogue request; the durable write itself remains
    // detached from the playback response.
    void getSharedPlaybackCardQuarantineStore()
      .record(bindingHash)
      .catch(() => false);
  } catch {
    // A database configuration fault must not change playback's independent
    // ACL result or turn this presentation-only optimization into a 500.
  }
}
