import 'server-only';

import { and, desc, eq, ne } from 'drizzle-orm';
import { getW3dsDatabase, type W3dsDatabase } from '../db/client';
import { type ViewerChatGrantPointerState, viewerChatGrantPointers } from '../db/schema';

/**
 * The database is a locator cache, not an authorization cache. Keep a small
 * set because duplicate/rotated viewer Chat envelopes can legitimately point
 * at the same direct conversation; every candidate still needs an exact,
 * current viewer-vault read before playback can proceed.
 */
export const defaultViewerChatGrantPointerCandidates = 3;

export interface ViewerChatGrantPointerKey {
  /** The signed-in viewer whose own eVault contains the Chat envelope. */
  viewerEName: string;
  /** Canonical owner/source of the direct conversation. */
  sourceEName: string;
  /** Canonical direct Chat identifier at that source. */
  sourceChatId: string;
  /** Opaque MetaEnvelope ID in the viewer's eVault. */
  viewerEnvelopeId: string;
}

export interface ViewerChatGrantPointerScope {
  viewerEName: string;
  sourceEName: string;
  sourceChatId: string;
}

/**
 * Server-only pointer metadata. `state` describes whether this local locator
 * may be tried; it is never an authorization result or entitlement.
 */
export interface ViewerChatGrantPointer extends ViewerChatGrantPointerKey {
  /** Optional eVault operation/envelope hash, never a media or payload hash. */
  envelopeHash?: string;
  state: ViewerChatGrantPointerState;
  /** Most recent positive observation of the pointer, not an access verdict. */
  observedAt: number;
  invalidatedAt?: number;
  revokedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertViewerChatGrantPointerInput extends ViewerChatGrantPointerKey {
  /** Optional source-provided envelope hash from an exact current observation. */
  envelopeHash?: string;
}

export interface ListViewerChatGrantPointerCandidatesInput extends ViewerChatGrantPointerScope {
  /** Active candidates only by default; state inspection remains server-only. */
  includeInactive?: boolean;
  /** Capped at the store's retention limit. */
  limit?: number;
}

/**
 * Persistence boundary for viewer-vault Chat pointers. It intentionally has
 * no `authorize`, `grant`, media URL, File, or stream-ticket method.
 */
export interface ViewerChatGrantPointerStore {
  /** Records a freshly and positively observed pointer, then enforces retention. */
  upsert(input: UpsertViewerChatGrantPointerInput): Promise<ViewerChatGrantPointer>;
  /** Lists candidates newest-first for one viewer/source/direct-Chat tuple. */
  listCandidates(
    input: ListViewerChatGrantPointerCandidatesInput,
  ): Promise<ViewerChatGrantPointer[]>;
  /** Marks exactly one stale pointer unusable without affecting a newer ID. */
  markInvalid(key: ViewerChatGrantPointerKey): Promise<ViewerChatGrantPointer | undefined>;
  /** Marks exactly one pointer revoked without deleting its bounded audit state. */
  revoke(key: ViewerChatGrantPointerKey): Promise<ViewerChatGrantPointer | undefined>;
  /** Removes exactly one pointer, for privacy cleanup or a terminal reconcile. */
  remove(key: ViewerChatGrantPointerKey): Promise<boolean>;
}

export interface ViewerChatGrantPointerStoreOptions {
  /** Maximum retained IDs for one viewer/source/direct-Chat tuple. Defaults to 3. */
  maxCandidates?: number;
  /** Injectable only for deterministic server tests. */
  now?: () => number;
}

interface CanonicalPointerKey {
  viewerEName: string;
  sourceEName: string;
  sourceChatId: string;
  viewerEnvelopeId: string;
}

interface CanonicalPointerScope {
  viewerEName: string;
  sourceEName: string;
  sourceChatId: string;
}

const eNamePattern = /^@[^\s@]+$/;
const maxIdentifierLength = 4_096;
const maxEnvelopeHashLength = 512;

function configuredMaxCandidates(options: ViewerChatGrantPointerStoreOptions | undefined): number {
  const value = options?.maxCandidates ?? defaultViewerChatGrantPointerCandidates;
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error('Viewer Chat grant pointer retention must be an integer from 1 through 16.');
  }
  return value;
}

function requireIdentifier(value: string, field: string, maxLength = maxIdentifierLength): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\u0000')) {
    throw new Error(`Viewer Chat grant pointer ${field} is invalid.`);
  }
  return normalized;
}

function normalizeEName(value: string, field: string): string {
  const candidate = requireIdentifier(value, field);
  const normalized = candidate.startsWith('@') ? candidate : `@${candidate}`;
  if (!eNamePattern.test(normalized)) {
    throw new Error(`Viewer Chat grant pointer ${field} must be a valid eName.`);
  }
  return normalized.toLowerCase();
}

function canonicalScope(input: ViewerChatGrantPointerScope): CanonicalPointerScope {
  return {
    viewerEName: normalizeEName(input.viewerEName, 'viewerEName'),
    sourceEName: normalizeEName(input.sourceEName, 'sourceEName'),
    sourceChatId: requireIdentifier(input.sourceChatId, 'sourceChatId'),
  };
}

function canonicalKey(input: ViewerChatGrantPointerKey): CanonicalPointerKey {
  return {
    ...canonicalScope(input),
    viewerEnvelopeId: requireIdentifier(input.viewerEnvelopeId, 'viewerEnvelopeId'),
  };
}

function optionalEnvelopeHash(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return requireIdentifier(value, 'envelopeHash', maxEnvelopeHashLength);
}

function pointerKey(key: CanonicalPointerKey): string {
  return `${key.viewerEName}\u0000${key.sourceEName}\u0000${key.sourceChatId}\u0000${key.viewerEnvelopeId}`;
}

function sameScope(pointer: ViewerChatGrantPointer, scope: CanonicalPointerScope): boolean {
  return (
    pointer.viewerEName === scope.viewerEName &&
    pointer.sourceEName === scope.sourceEName &&
    pointer.sourceChatId === scope.sourceChatId
  );
}

function newestFirst(left: ViewerChatGrantPointer, right: ViewerChatGrantPointer): number {
  return (
    right.observedAt - left.observedAt ||
    right.updatedAt - left.updatedAt ||
    right.viewerEnvelopeId.localeCompare(left.viewerEnvelopeId)
  );
}

function clonePointer(pointer: ViewerChatGrantPointer): ViewerChatGrantPointer {
  return { ...pointer };
}

function normalizeLimit(limit: number | undefined, maxCandidates: number): number {
  if (limit === undefined) return maxCandidates;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Viewer Chat grant pointer candidate limit must be a positive integer.');
  }
  return Math.min(limit, maxCandidates);
}

function toPointer(row: typeof viewerChatGrantPointers.$inferSelect): ViewerChatGrantPointer {
  return {
    viewerEName: row.viewerEName,
    sourceEName: row.sourceEName,
    sourceChatId: row.sourceChatId,
    viewerEnvelopeId: row.viewerEnvelopeId,
    ...(row.envelopeHash ? { envelopeHash: row.envelopeHash } : {}),
    state: row.state,
    observedAt: row.observedAt.getTime(),
    ...(row.invalidatedAt ? { invalidatedAt: row.invalidatedAt.getTime() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.getTime() } : {}),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** In-memory implementation for tests and local configuration without DATABASE_URL. */
export class InMemoryViewerChatGrantPointerStore implements ViewerChatGrantPointerStore {
  private readonly pointers = new Map<string, ViewerChatGrantPointer>();
  private readonly maxCandidates: number;
  private readonly now: () => number;

  constructor(options?: ViewerChatGrantPointerStoreOptions) {
    this.maxCandidates = configuredMaxCandidates(options);
    this.now = options?.now ?? Date.now;
  }

  async upsert(input: UpsertViewerChatGrantPointerInput): Promise<ViewerChatGrantPointer> {
    const key = canonicalKey(input);
    const hash = optionalEnvelopeHash(input.envelopeHash);
    const now = this.now();
    const storageKey = pointerKey(key);
    const existing = this.pointers.get(storageKey);
    let pointer: ViewerChatGrantPointer;
    if (existing) {
      const { invalidatedAt: _invalidatedAt, revokedAt: _revokedAt, ...active } = existing;
      pointer = {
        ...active,
        ...(hash !== undefined ? { envelopeHash: hash } : {}),
        state: 'active',
        observedAt: now,
        updatedAt: now,
      };
    } else {
      pointer = {
        ...key,
        ...(hash !== undefined ? { envelopeHash: hash } : {}),
        state: 'active',
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      };
    }
    this.pointers.set(storageKey, pointer);
    this.enforceRetention(canonicalScope(key), key.viewerEnvelopeId);
    return clonePointer(pointer);
  }

  async listCandidates(
    input: ListViewerChatGrantPointerCandidatesInput,
  ): Promise<ViewerChatGrantPointer[]> {
    const scope = canonicalScope(input);
    const limit = normalizeLimit(input.limit, this.maxCandidates);
    return [...this.pointers.values()]
      .filter(
        (pointer) =>
          sameScope(pointer, scope) && (input.includeInactive || pointer.state === 'active'),
      )
      .sort(newestFirst)
      .slice(0, limit)
      .map(clonePointer);
  }

  async markInvalid(
    keyInput: ViewerChatGrantPointerKey,
  ): Promise<ViewerChatGrantPointer | undefined> {
    const key = canonicalKey(keyInput);
    const storedKey = pointerKey(key);
    const existing = this.pointers.get(storedKey);
    if (!existing || existing.state === 'revoked')
      return existing ? clonePointer(existing) : undefined;
    const now = this.now();
    const updated: ViewerChatGrantPointer = {
      ...existing,
      state: 'invalid',
      invalidatedAt: now,
      updatedAt: now,
    };
    this.pointers.set(storedKey, updated);
    return clonePointer(updated);
  }

  async revoke(keyInput: ViewerChatGrantPointerKey): Promise<ViewerChatGrantPointer | undefined> {
    const key = canonicalKey(keyInput);
    const storedKey = pointerKey(key);
    const existing = this.pointers.get(storedKey);
    if (!existing) return undefined;
    const now = this.now();
    const updated: ViewerChatGrantPointer = {
      ...existing,
      state: 'revoked',
      revokedAt: now,
      updatedAt: now,
    };
    this.pointers.set(storedKey, updated);
    return clonePointer(updated);
  }

  async remove(keyInput: ViewerChatGrantPointerKey): Promise<boolean> {
    return this.pointers.delete(pointerKey(canonicalKey(keyInput)));
  }

  private enforceRetention(scope: CanonicalPointerScope, currentEnvelopeId: string): void {
    const candidates = [...this.pointers.values()]
      .filter((pointer) => sameScope(pointer, scope))
      .sort(newestFirst);
    // A newly observed positive pointer must survive an equal-timestamp tie;
    // retain it first, then fill the remaining bounded slots newest-first.
    const retained = new Set([
      currentEnvelopeId,
      ...candidates
        .filter((pointer) => pointer.viewerEnvelopeId !== currentEnvelopeId)
        .slice(0, this.maxCandidates - 1)
        .map((pointer) => pointer.viewerEnvelopeId),
    ]);
    const stale = candidates.filter((pointer) => !retained.has(pointer.viewerEnvelopeId));
    for (const pointer of stale) {
      this.pointers.delete(pointerKey(pointer));
    }
  }
}

/** PostgreSQL implementation used whenever DATABASE_URL is configured. */
export class PostgresViewerChatGrantPointerStore implements ViewerChatGrantPointerStore {
  private readonly maxCandidates: number;
  private readonly now: () => number;

  constructor(
    private readonly db: W3dsDatabase,
    options?: ViewerChatGrantPointerStoreOptions,
  ) {
    this.maxCandidates = configuredMaxCandidates(options);
    this.now = options?.now ?? Date.now;
  }

  async upsert(input: UpsertViewerChatGrantPointerInput): Promise<ViewerChatGrantPointer> {
    const key = canonicalKey(input);
    const envelopeHash = optionalEnvelopeHash(input.envelopeHash);
    const now = new Date(this.now());
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(viewerChatGrantPointers)
        .values({
          ...key,
          envelopeHash: envelopeHash ?? null,
          state: 'active',
          observedAt: now,
          invalidatedAt: null,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            viewerChatGrantPointers.viewerEName,
            viewerChatGrantPointers.sourceEName,
            viewerChatGrantPointers.sourceChatId,
            viewerChatGrantPointers.viewerEnvelopeId,
          ],
          set: {
            ...(envelopeHash !== undefined ? { envelopeHash } : {}),
            state: 'active',
            observedAt: now,
            invalidatedAt: null,
            revokedAt: null,
            updatedAt: now,
          },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Failed to persist viewer Chat grant pointer.');

      const candidates = await tx
        .select()
        .from(viewerChatGrantPointers)
        .where(scopeWhere(key))
        .orderBy(
          desc(viewerChatGrantPointers.observedAt),
          desc(viewerChatGrantPointers.updatedAt),
          desc(viewerChatGrantPointers.viewerEnvelopeId),
        );
      const retained = new Set([
        key.viewerEnvelopeId,
        ...candidates
          .filter((candidate) => candidate.viewerEnvelopeId !== key.viewerEnvelopeId)
          .slice(0, this.maxCandidates - 1)
          .map((candidate) => candidate.viewerEnvelopeId),
      ]);
      for (const stale of candidates.filter(
        (candidate) => !retained.has(candidate.viewerEnvelopeId),
      )) {
        await tx.delete(viewerChatGrantPointers).where(pointerWhere(stale));
      }
      return toPointer(row);
    });
  }

  async listCandidates(
    input: ListViewerChatGrantPointerCandidatesInput,
  ): Promise<ViewerChatGrantPointer[]> {
    const scope = canonicalScope(input);
    const limit = normalizeLimit(input.limit, this.maxCandidates);
    const rows = await this.db
      .select()
      .from(viewerChatGrantPointers)
      .where(
        input.includeInactive
          ? scopeWhere(scope)
          : and(scopeWhere(scope), eq(viewerChatGrantPointers.state, 'active')),
      )
      .orderBy(
        desc(viewerChatGrantPointers.observedAt),
        desc(viewerChatGrantPointers.updatedAt),
        desc(viewerChatGrantPointers.viewerEnvelopeId),
      )
      .limit(limit);
    return rows.map(toPointer);
  }

  async markInvalid(
    keyInput: ViewerChatGrantPointerKey,
  ): Promise<ViewerChatGrantPointer | undefined> {
    const key = canonicalKey(keyInput);
    const now = new Date(this.now());
    const rows = await this.db
      .update(viewerChatGrantPointers)
      .set({ state: 'invalid', invalidatedAt: now, updatedAt: now })
      .where(and(pointerWhere(key), ne(viewerChatGrantPointers.state, 'revoked')))
      .returning();
    if (rows[0]) return toPointer(rows[0]);
    return this.findExact(key);
  }

  async revoke(keyInput: ViewerChatGrantPointerKey): Promise<ViewerChatGrantPointer | undefined> {
    const key = canonicalKey(keyInput);
    const now = new Date(this.now());
    const rows = await this.db
      .update(viewerChatGrantPointers)
      .set({ state: 'revoked', revokedAt: now, updatedAt: now })
      .where(pointerWhere(key))
      .returning();
    return rows[0] ? toPointer(rows[0]) : undefined;
  }

  async remove(keyInput: ViewerChatGrantPointerKey): Promise<boolean> {
    const rows = await this.db
      .delete(viewerChatGrantPointers)
      .where(pointerWhere(canonicalKey(keyInput)))
      .returning({ viewerEnvelopeId: viewerChatGrantPointers.viewerEnvelopeId });
    return rows.length > 0;
  }

  private async findExact(key: CanonicalPointerKey): Promise<ViewerChatGrantPointer | undefined> {
    const rows = await this.db
      .select()
      .from(viewerChatGrantPointers)
      .where(pointerWhere(key))
      .limit(1);
    return rows[0] ? toPointer(rows[0]) : undefined;
  }
}

function scopeWhere(scope: CanonicalPointerScope) {
  return and(
    eq(viewerChatGrantPointers.viewerEName, scope.viewerEName),
    eq(viewerChatGrantPointers.sourceEName, scope.sourceEName),
    eq(viewerChatGrantPointers.sourceChatId, scope.sourceChatId),
  );
}

function pointerWhere(key: CanonicalPointerKey | ViewerChatGrantPointer) {
  return and(scopeWhere(key), eq(viewerChatGrantPointers.viewerEnvelopeId, key.viewerEnvelopeId));
}

/** Durable default when DATABASE_URL exists; memory is limited to tests/local dev. */
export function createViewerChatGrantPointerStore(
  options?: ViewerChatGrantPointerStoreOptions,
): ViewerChatGrantPointerStore {
  return new PostgresViewerChatGrantPointerStore(getW3dsDatabase(), options);
}

let defaultStore: ViewerChatGrantPointerStore | undefined;
let memoryFallback: ViewerChatGrantPointerStore | undefined;

export function getViewerChatGrantPointerStore(): ViewerChatGrantPointerStore {
  if (defaultStore) return defaultStore;
  if (process.env.DATABASE_URL?.trim()) {
    try {
      defaultStore = createViewerChatGrantPointerStore();
      return defaultStore;
    } catch {
      // Tests and local read-only inventory can run before a migration exists.
    }
  }
  memoryFallback ??= new InMemoryViewerChatGrantPointerStore();
  return memoryFallback;
}

/** Test-only injection; production code must not replace the durable default. */
export function setViewerChatGrantPointerStoreForTests(store?: ViewerChatGrantPointerStore): void {
  defaultStore = store;
  if (!store) memoryFallback = undefined;
}
