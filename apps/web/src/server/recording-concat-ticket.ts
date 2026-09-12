import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import { getW3dsDatabase, type W3dsDatabase } from './db/client';
import { recordingConcatTicketLocks, recordingConcatTickets } from './db/schema';
import { createCorrelationId, normalizeCorrelationId } from './ops-observability';

// A ticket that has not reached the player is discarded quickly. Once the
// browser has opened it, it must remain valid long enough for a real call
// recording (including a pause), rather than expiring halfway through it.
const pendingTicketLifetimeMs = 2 * 60_000;
const activeTicketLifetimeMs = 8 * 60 * 60_000;
/**
 * A live concat process renews this lease well before it expires. It frees a
 * global admission slot soon after a process/pod crash without imposing a
 * shorter playback lifetime on a valid paused recording.
 */
export const recordingConcatTicketActiveLeaseMs = 90_000;
export const recordingConcatTicketLeaseHeartbeatMs = 25_000;
const maxOpenTickets = 64;
const maxTicketsPerViewer = 4;
// Call recorders commonly emit about 45-second files. This supports roughly
// six hours of one continuous recording without falling back to user-visible
// ~20-minute chunks while keeping one request bounded.
export const maxRecordingSegments = 512;
const maxStreamIdLength = 8_192;
const maxViewerEVaultUriLength = 8_192;
// This is a signed, viewer-and-stream-bound hint, not a grant. Keep its
// storage bound aligned with the receipt verifier without assuming its wire
// format here: this ticket module treats it as opaque server-only data.
const maxInitialAuthorizationReceiptLength = 1_024;
const maxTicketSourceBytes = 1 * 1_024 * 1_024;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const issueLockId = 'recording-concat-ticket-issue';
const encryptedPayloadVersion = 'v1';
const encryptionContext = 'vidak:recording-concat-ticket:v1\0';

export interface RecordingTicketViewer {
  eName: string;
  eVaultUri?: string;
}

interface RecordingTicket {
  id: string;
  segmentKey: string;
  /** Opaque, server-only join key for the ticket, segment, and ffmpeg timings. */
  correlationId: string;
  viewer: RecordingTicketViewer;
  /** Lower-cased only for quota lookup; preserve `viewer.eName` for eVault. */
  viewerENameKey: string;
  streamIds: string[];
  /**
   * A short-lived authorization warmup receipt for source zero only. It stays
   * encrypted with the ticket and must never be placed in a browser URL.
   */
  initialAuthorizationReceipt?: string;
  expiresAt: number;
  activeLeaseExpiresAt?: number;
  claimed: boolean;
}

interface EncryptedTicketPayload {
  segmentKey: string;
  correlationId: string;
  eVaultUri?: string;
  streamIds: string[];
  initialAuthorizationReceipt?: string;
}

/**
 * Optional server-only context carried by a continuous-recording ticket.
 * Existing callers can omit it; it is intentionally placed after the store
 * argument in the issue API to keep every existing positional call valid.
 */
export interface RecordingConcatTicketIssueOptions {
  initialAuthorizationReceipt?: string;
}

type TicketAdmission = 'issued' | 'global_capacity' | 'viewer_capacity';
type TicketClaimResult =
  | { kind: 'claimed'; record: RecordingTicket }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'busy' };

/**
 * Persistence boundary for short-lived, viewer-bound concat tickets. The
 * production implementation is PostgreSQL; the in-memory implementation is
 * exported only so tests can run without making a database a hidden fixture.
 */
export interface RecordingConcatTicketStore {
  issue(record: RecordingTicket, now: number): Promise<TicketAdmission>;
  claim(
    ticket: string,
    viewer: Pick<RecordingTicketViewer, 'eName'>,
    now: number,
  ): Promise<TicketClaimResult>;
  read(ticket: string, now: number): Promise<RecordingTicket | undefined>;
  replaceSegment(
    ticket: string,
    segmentKey: string | null,
    streamIndex: number,
    streamId: string,
    now: number,
  ): Promise<boolean>;
  renewLease(ticket: string, now: number): Promise<boolean>;
  release(ticket: string): Promise<void>;
  clear?(): Promise<void>;
}

export class RecordingConcatTicketError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_recording' | 'not_found' | 'forbidden' | 'busy',
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Validates only opaque, viewer-bound stream grants. Source authorization and
 * media URL resolution remain in the lazy internal segment route.
 */
export function parseRecordingStreamIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > maxRecordingSegments) {
    throw new RecordingConcatTicketError(
      'This recording does not have a valid set of sources.',
      'invalid_recording',
      400,
    );
  }
  const streamIds = value.map(normalizeRecordingStreamId);
  if (new Set(streamIds).size !== streamIds.length) {
    throw new RecordingConcatTicketError(
      'This recording does not have a valid set of sources.',
      'invalid_recording',
      400,
    );
  }
  if (recordingStreamIdsByteLength(streamIds) > maxTicketSourceBytes) {
    throw new RecordingConcatTicketError(
      'This recording has too many source references to open safely.',
      'invalid_recording',
      400,
    );
  }
  return streamIds;
}

/**
 * Issues a short-lived server-side source list; no source URL is stored. The
 * PostgreSQL admission lock makes the capacity limits exact across replicas.
 */
export async function issueRecordingConcatTicket(
  viewer: RecordingTicketViewer,
  streamIds: readonly string[],
  now = Date.now(),
  correlationId = createCorrelationId(),
  store?: RecordingConcatTicketStore,
  options: RecordingConcatTicketIssueOptions = {},
): Promise<{ ticket: string; playbackPath: string }> {
  const validStreamIds = parseRecordingStreamIds(streamIds);
  const normalizedViewer = normalizeViewer(viewer);
  const initialAuthorizationReceipt = normalizeInitialAuthorizationReceipt(
    options.initialAuthorizationReceipt,
  );
  const ticket = opaqueToken();
  const record: RecordingTicket = {
    id: ticket,
    segmentKey: opaqueToken(),
    // Only route-generated or locally generated opaque ids are expected here.
    // Defensively normalize anyway so a future caller cannot place arbitrary
    // request context into a server-side timing log.
    correlationId: normalizeCorrelationId(correlationId) ?? createCorrelationId(),
    viewer: normalizedViewer.viewer,
    viewerENameKey: normalizedViewer.key,
    streamIds: validStreamIds,
    ...(initialAuthorizationReceipt ? { initialAuthorizationReceipt } : {}),
    expiresAt: now + pendingTicketLifetimeMs,
    claimed: false,
  };
  const admission = await withTicketStore(() => resolveStore(store).issue(record, now));
  if (admission === 'global_capacity') {
    throw new RecordingConcatTicketError(
      'The recording service is busy. Please try again shortly.',
      'busy',
      503,
    );
  }
  if (admission === 'viewer_capacity') {
    throw new RecordingConcatTicketError(
      'Too many recordings are already open for this account.',
      'busy',
      429,
    );
  }
  return {
    ticket,
    playbackPath: `/api/evault/recordings/${encodeURIComponent(ticket)}`,
  };
}

/**
 * Claims the outer playback stream for its authenticated viewer and creates
 * loopback-only URLs for ffmpeg. The per-segment key is never returned to the
 * browser and protects the internal endpoint if an outer ticket is observed.
 */
export async function claimRecordingConcatTicket(
  ticket: string,
  viewer: Pick<RecordingTicketViewer, 'eName'>,
  internalOrigin = resolveInternalMediaOrigin(),
  now = Date.now(),
  store?: RecordingConcatTicketStore,
): Promise<{
  sourceUrls: string[];
  correlationId: string;
  /** Internal route closure; never serialized into a browser response. */
  renewLease: () => Promise<boolean>;
  release: () => Promise<void>;
}> {
  const origin = parseInternalMediaOrigin(internalOrigin);
  requireOpaqueTicket(ticket);
  const activeStore = resolveStore(store);
  const result = await withTicketStore(() => activeStore.claim(ticket, viewer, now));
  if (result.kind === 'not_found') throw unavailableTicketError();
  if (result.kind === 'forbidden') {
    throw new RecordingConcatTicketError('This recording cannot be opened.', 'forbidden', 403);
  }
  if (result.kind === 'busy') {
    throw new RecordingConcatTicketError(
      'This recording is already opening. Please retry playback.',
      'busy',
      409,
    );
  }
  const record = result.record;
  const sourceUrls = record.streamIds.map((_, index) => {
    const url = new URL(
      `/api/evault/recordings/${encodeURIComponent(record.id)}/segments/${index}`,
      origin,
    );
    url.searchParams.set('key', record.segmentKey);
    return url.toString();
  });
  return {
    sourceUrls,
    correlationId: record.correlationId,
    renewLease: () => renewRecordingConcatTicketLease(record.id, activeStore),
    release: () => releaseRecordingConcatTicket(record.id, activeStore),
  };
}

/** Resolves exactly one private stream for a loopback ffmpeg request. */
export async function readRecordingConcatSegment(
  ticket: string,
  segmentKey: string | null,
  index: string,
  now = Date.now(),
  store?: RecordingConcatTicketStore,
): Promise<{
  viewer: RecordingTicketViewer;
  streamId: string;
  correlationId: string;
  /** Present only for source zero; later segments must reauthorize normally. */
  initialAuthorizationReceipt?: string;
}> {
  requireOpaqueTicket(ticket);
  const record = await withTicketStore(() => resolveStore(store).read(ticket, now));
  if (!record?.claimed || !sameOpaqueToken(record.segmentKey, segmentKey)) {
    throw unavailableSegmentError();
  }
  const streamIndex = parseSegmentIndex(index);
  const streamId = record.streamIds[streamIndex];
  if (!streamId) throw unavailableSegmentError();
  return {
    viewer: record.viewer,
    streamId,
    correlationId: record.correlationId,
    ...(streamIndex === 0 && record.initialAuthorizationReceipt
      ? { initialAuthorizationReceipt: record.initialAuthorizationReceipt }
      : {}),
  };
}

/**
 * Replaces an expired sealed stream grant after it is renewed. This leaves
 * the browser-visible ticket unchanged and means a long recording can cross
 * the four-hour grant boundary without pre-resolving every source.
 */
export async function replaceRecordingConcatSegment(
  ticket: string,
  segmentKey: string | null,
  index: string,
  streamId: string,
  now = Date.now(),
  store?: RecordingConcatTicketStore,
): Promise<void> {
  requireOpaqueTicket(ticket);
  const streamIndex = parseSegmentIndex(index);
  const replacement = normalizeRecordingStreamId(streamId);
  const replaced = await withTicketStore(() =>
    resolveStore(store).replaceSegment(ticket, segmentKey, streamIndex, replacement, now),
  );
  if (!replaced) throw unavailableSegmentError();
}

export async function releaseRecordingConcatTicket(
  ticket: string,
  store?: RecordingConcatTicketStore,
): Promise<void> {
  if (!opaqueTokenPattern.test(ticket)) return;
  await withTicketStore(() => resolveStore(store).release(ticket));
}

/**
 * Server-only active lease renewal. The browser never receives this capability:
 * it is invoked by the ffmpeg-owning route while its response stays live.
 */
export async function renewRecordingConcatTicketLease(
  ticket: string,
  store?: RecordingConcatTicketStore,
  now = Date.now(),
): Promise<boolean> {
  if (!opaqueTokenPattern.test(ticket)) return false;
  return withTicketStore(() => resolveStore(store).renewLease(ticket, now));
}

/** Test-only isolated store. It is never selected by production request paths. */
export class InMemoryRecordingConcatTicketStore implements RecordingConcatTicketStore {
  private readonly tickets = new Map<string, RecordingTicket>();

  async issue(record: RecordingTicket, now: number): Promise<TicketAdmission> {
    this.pruneExpired(now);
    if (this.tickets.size >= maxOpenTickets) return 'global_capacity';
    if (this.countTicketsForViewer(record.viewerENameKey) >= maxTicketsPerViewer) {
      return 'viewer_capacity';
    }
    this.tickets.set(record.id, cloneTicket(record));
    return 'issued';
  }

  async claim(
    ticket: string,
    viewer: Pick<RecordingTicketViewer, 'eName'>,
    now: number,
  ): Promise<TicketClaimResult> {
    const record = this.readActive(ticket, now);
    if (!record) return { kind: 'not_found' };
    if (!sameViewer(record.viewer.eName, viewer.eName)) return { kind: 'forbidden' };
    if (record.claimed) return { kind: 'busy' };
    const claimed = {
      ...record,
      claimed: true,
      expiresAt: now + activeTicketLifetimeMs,
      activeLeaseExpiresAt: now + recordingConcatTicketActiveLeaseMs,
    };
    this.tickets.set(ticket, cloneTicket(claimed));
    return { kind: 'claimed', record: cloneTicket(claimed) };
  }

  async read(ticket: string, now: number): Promise<RecordingTicket | undefined> {
    const record = this.readActive(ticket, now);
    return record ? cloneTicket(record) : undefined;
  }

  async replaceSegment(
    ticket: string,
    segmentKey: string | null,
    streamIndex: number,
    streamId: string,
    now: number,
  ): Promise<boolean> {
    const record = this.readActive(ticket, now);
    if (!canReplaceSegment(record, segmentKey, streamIndex, streamId)) return false;
    const updated = cloneTicket(record);
    updated.streamIds[streamIndex] = streamId;
    // The receipt is bound to the original first sealed stream. A renewed
    // stream must not inherit that warmup hint, even though the segment route
    // will verify it again defensively before use.
    if (streamIndex === 0) delete updated.initialAuthorizationReceipt;
    this.tickets.set(ticket, updated);
    return true;
  }

  async renewLease(ticket: string, now: number): Promise<boolean> {
    const record = this.tickets.get(ticket);
    if (!record?.claimed || record.expiresAt <= now) return false;
    this.tickets.set(ticket, {
      ...cloneTicket(record),
      activeLeaseExpiresAt: now + recordingConcatTicketActiveLeaseMs,
    });
    return true;
  }

  async release(ticket: string): Promise<void> {
    this.tickets.delete(ticket);
  }

  async clear(): Promise<void> {
    this.tickets.clear();
  }

  private readActive(ticket: string, now: number): RecordingTicket | undefined {
    this.pruneExpired(now);
    return this.tickets.get(ticket);
  }

  private pruneExpired(now: number): void {
    for (const [ticket, record] of this.tickets) {
      if (
        record.expiresAt <= now ||
        (record.claimed && (!record.activeLeaseExpiresAt || record.activeLeaseExpiresAt <= now))
      ) {
        this.tickets.delete(ticket);
      }
    }
  }

  private countTicketsForViewer(viewerENameKey: string): number {
    let count = 0;
    for (const record of this.tickets.values()) {
      if (record.viewerENameKey === viewerENameKey) count += 1;
    }
    return count;
  }
}

/** Durable production implementation shared by all application replicas. */
export class PostgresRecordingConcatTicketStore implements RecordingConcatTicketStore {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly db: W3dsDatabase,
    encryptionKey: Buffer = resolveRecordingConcatTicketEncryptionKey(),
  ) {
    if (encryptionKey.byteLength !== 32) {
      throw new Error('Recording concat ticket encryption key must be 32 bytes.');
    }
    this.encryptionKey = Buffer.from(encryptionKey);
  }

  async issue(record: RecordingTicket, now: number): Promise<TicketAdmission> {
    const nowDate = new Date(now);
    return this.db.transaction(async (tx) => {
      // Every issuer locks the same durable row before pruning/counting. This
      // makes both admission limits exact under concurrent cross-replica POSTs.
      await tx
        .insert(recordingConcatTicketLocks)
        .values({ id: issueLockId, createdAt: nowDate, updatedAt: nowDate })
        .onConflictDoNothing();
      const [lock] = await tx
        .select({ id: recordingConcatTicketLocks.id })
        .from(recordingConcatTicketLocks)
        .where(eq(recordingConcatTicketLocks.id, issueLockId))
        .for('update')
        .limit(1);
      if (!lock) throw new Error('Recording ticket admission lock is unavailable.');

      await tx.delete(recordingConcatTickets).where(staleTicketWhere(nowDate));
      const [total] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(recordingConcatTickets);
      if (Number(total?.count ?? 0) >= maxOpenTickets) return 'global_capacity';
      const [forViewer] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(recordingConcatTickets)
        .where(eq(recordingConcatTickets.viewerENameKey, record.viewerENameKey));
      if (Number(forViewer?.count ?? 0) >= maxTicketsPerViewer) return 'viewer_capacity';

      await tx
        .insert(recordingConcatTickets)
        .values(ticketInsertValues(record, nowDate, this.encryptionKey));
      return 'issued';
    });
  }

  async claim(
    ticket: string,
    viewer: Pick<RecordingTicketViewer, 'eName'>,
    now: number,
  ): Promise<TicketClaimResult> {
    const nowDate = new Date(now);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(recordingConcatTickets)
        .where(eq(recordingConcatTickets.id, ticket))
        .for('update')
        .limit(1);
      if (!row) return { kind: 'not_found' };
      const record = ticketFromRow(row, this.encryptionKey);
      if (record.expiresAt <= now) {
        await tx.delete(recordingConcatTickets).where(eq(recordingConcatTickets.id, ticket));
        return { kind: 'not_found' };
      }
      if (!sameViewer(record.viewer.eName, viewer.eName)) return { kind: 'forbidden' };
      if (record.claimed) {
        if (!hasLiveActiveLease(record, now)) {
          await tx.delete(recordingConcatTickets).where(ticketLeaseExpiredWhere(ticket, nowDate));
          return { kind: 'not_found' };
        }
        return { kind: 'busy' };
      }
      const [claimed] = await tx
        .update(recordingConcatTickets)
        .set({
          claimed: true,
          activeLeaseExpiresAt: new Date(now + recordingConcatTicketActiveLeaseMs),
          expiresAt: new Date(now + activeTicketLifetimeMs),
          updatedAt: nowDate,
        })
        .where(
          and(eq(recordingConcatTickets.id, ticket), eq(recordingConcatTickets.claimed, false)),
        )
        .returning();
      return claimed
        ? { kind: 'claimed', record: ticketFromRow(claimed, this.encryptionKey) }
        : { kind: 'busy' };
    });
  }

  async read(ticket: string, now: number): Promise<RecordingTicket | undefined> {
    const nowDate = new Date(now);
    const [row] = await this.db
      .select()
      .from(recordingConcatTickets)
      .where(eq(recordingConcatTickets.id, ticket))
      .limit(1);
    if (!row) return undefined;
    const record = ticketFromRow(row, this.encryptionKey);
    if (record.expiresAt > now && (!record.claimed || hasLiveActiveLease(record, now))) {
      return record;
    }
    // Conditional cleanup cannot erase a ticket a concurrent claimant has
    // extended after this read.
    await this.db
      .delete(recordingConcatTickets)
      .where(
        record.expiresAt <= now
          ? and(
              eq(recordingConcatTickets.id, ticket),
              lte(recordingConcatTickets.expiresAt, nowDate),
            )
          : ticketLeaseExpiredWhere(ticket, nowDate),
      );
    return undefined;
  }

  async replaceSegment(
    ticket: string,
    segmentKey: string | null,
    streamIndex: number,
    streamId: string,
    now: number,
  ): Promise<boolean> {
    const nowDate = new Date(now);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(recordingConcatTickets)
        .where(eq(recordingConcatTickets.id, ticket))
        .for('update')
        .limit(1);
      if (!row) return false;
      const record = ticketFromRow(row, this.encryptionKey);
      if (record.expiresAt <= now) {
        await tx.delete(recordingConcatTickets).where(eq(recordingConcatTickets.id, ticket));
        return false;
      }
      if (!hasLiveActiveLease(record, now)) {
        await tx.delete(recordingConcatTickets).where(ticketLeaseExpiredWhere(ticket, nowDate));
        return false;
      }
      if (!canReplaceSegment(record, segmentKey, streamIndex, streamId)) return false;
      const updated = cloneTicket(record);
      updated.streamIds[streamIndex] = streamId;
      if (streamIndex === 0) delete updated.initialAuthorizationReceipt;
      await tx
        .update(recordingConcatTickets)
        .set({
          encryptedPayload: encryptTicketPayload(updated, this.encryptionKey),
          updatedAt: nowDate,
        })
        .where(eq(recordingConcatTickets.id, ticket));
      return true;
    });
  }

  async renewLease(ticket: string, now: number): Promise<boolean> {
    const nowDate = new Date(now);
    const rows = await this.db
      .update(recordingConcatTickets)
      .set({
        activeLeaseExpiresAt: new Date(now + recordingConcatTicketActiveLeaseMs),
        updatedAt: nowDate,
      })
      .where(
        and(
          eq(recordingConcatTickets.id, ticket),
          eq(recordingConcatTickets.claimed, true),
          gt(recordingConcatTickets.expiresAt, nowDate),
        ),
      )
      .returning({ id: recordingConcatTickets.id });
    return rows.length > 0;
  }

  async release(ticket: string): Promise<void> {
    await this.db.delete(recordingConcatTickets).where(eq(recordingConcatTickets.id, ticket));
  }

  async clear(): Promise<void> {
    await this.db.delete(recordingConcatTickets);
  }
}

/** Production requests always use PostgreSQL, never process-local storage. */
export function createRecordingConcatTicketStore(
  database: W3dsDatabase = getW3dsDatabase(),
  encryptionKey: Buffer = resolveRecordingConcatTicketEncryptionKey(),
): RecordingConcatTicketStore {
  return new PostgresRecordingConcatTicketStore(database, encryptionKey);
}

let testStoreOverride: RecordingConcatTicketStore | undefined;
let legacyTestStore: InMemoryRecordingConcatTicketStore | undefined;

/** Test-only injection; production code cannot opt into a memory fallback. */
export function setRecordingConcatTicketStoreForTests(store?: RecordingConcatTicketStore): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Recording concat ticket stores may only be replaced in tests.');
  }
  testStoreOverride = store;
  if (!store) legacyTestStore = undefined;
}

/** Compatibility helper for existing isolated route tests. */
export async function resetRecordingConcatTicketsForTests(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Recording concat tickets may only be reset in tests.');
  }
  legacyTestStore ??= new InMemoryRecordingConcatTicketStore();
  testStoreOverride = legacyTestStore;
  await legacyTestStore.clear();
}

export function resolveInternalMediaOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.INTERNAL_MEDIA_ORIGIN?.trim();
  const port = env.PORT?.trim() || '3000';
  const value = configured || `http://127.0.0.1:${port}`;
  return parseInternalMediaOrigin(value).origin;
}

/**
 * Shared W3DS JWT material is already mandatory for authenticated production
 * deployment. Derive a domain-separated 256-bit key so every replica can
 * decrypt a valid short-lived ticket without adding a separate secret that
 * could accidentally diverge across pods.
 */
export function resolveRecordingConcatTicketEncryptionKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const secret = env.W3DS_AUTH_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('Recording concat ticket encryption requires W3DS_AUTH_JWT_SECRET.');
  }
  return createHash('sha256').update(encryptionContext).update(secret, 'utf8').digest();
}

function resolveStore(store: RecordingConcatTicketStore | undefined): RecordingConcatTicketStore {
  return store ?? testStoreOverride ?? createRecordingConcatTicketStore();
}

async function withTicketStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RecordingConcatTicketError) throw error;
    // Database topology, migration, and encrypted-row failures must fail
    // closed. An in-memory fallback would break cross-replica revocation.
    throw new RecordingConcatTicketError(
      'The recording service is temporarily unavailable. Please retry playback.',
      'busy',
      503,
    );
  }
}

function hasLiveActiveLease(record: RecordingTicket, now: number): boolean {
  return Boolean(record.activeLeaseExpiresAt && record.activeLeaseExpiresAt > now);
}

function staleTicketWhere(now: Date) {
  return or(
    lte(recordingConcatTickets.expiresAt, now),
    and(
      eq(recordingConcatTickets.claimed, true),
      or(
        isNull(recordingConcatTickets.activeLeaseExpiresAt),
        lte(recordingConcatTickets.activeLeaseExpiresAt, now),
      ),
    ),
  );
}

function ticketLeaseExpiredWhere(ticket: string, now: Date) {
  return and(
    eq(recordingConcatTickets.id, ticket),
    eq(recordingConcatTickets.claimed, true),
    or(
      isNull(recordingConcatTickets.activeLeaseExpiresAt),
      lte(recordingConcatTickets.activeLeaseExpiresAt, now),
    ),
  );
}

function ticketInsertValues(record: RecordingTicket, now: Date, encryptionKey: Buffer) {
  return {
    id: record.id,
    viewerEName: record.viewer.eName,
    viewerENameKey: record.viewerENameKey,
    encryptedPayload: encryptTicketPayload(record, encryptionKey),
    claimed: record.claimed,
    activeLeaseExpiresAt: record.activeLeaseExpiresAt
      ? new Date(record.activeLeaseExpiresAt)
      : null,
    expiresAt: new Date(record.expiresAt),
    createdAt: now,
    updatedAt: now,
  };
}

function ticketFromRow(
  row: typeof recordingConcatTickets.$inferSelect,
  encryptionKey: Buffer,
): RecordingTicket {
  if (!opaqueTokenPattern.test(row.id) || !row.viewerEName.trim() || !row.viewerENameKey.trim()) {
    throw new Error('Recording concat ticket row is invalid.');
  }
  const payload = decryptTicketPayload(
    row.encryptedPayload,
    row.id,
    row.viewerENameKey,
    encryptionKey,
  );
  return {
    id: row.id,
    segmentKey: payload.segmentKey,
    correlationId: payload.correlationId,
    viewer: {
      eName: row.viewerEName,
      ...(payload.eVaultUri ? { eVaultUri: payload.eVaultUri } : {}),
    },
    viewerENameKey: row.viewerENameKey,
    streamIds: payload.streamIds,
    ...(payload.initialAuthorizationReceipt
      ? { initialAuthorizationReceipt: payload.initialAuthorizationReceipt }
      : {}),
    expiresAt: row.expiresAt.getTime(),
    ...(row.activeLeaseExpiresAt
      ? { activeLeaseExpiresAt: row.activeLeaseExpiresAt.getTime() }
      : {}),
    claimed: row.claimed,
  };
}

function encryptTicketPayload(record: RecordingTicket, encryptionKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(ticketAad(record.id, record.viewerENameKey));
  const plaintext = JSON.stringify({
    segmentKey: record.segmentKey,
    correlationId: record.correlationId,
    ...(record.viewer.eVaultUri ? { eVaultUri: record.viewer.eVaultUri } : {}),
    streamIds: record.streamIds,
    ...(record.initialAuthorizationReceipt
      ? { initialAuthorizationReceipt: record.initialAuthorizationReceipt }
      : {}),
  } satisfies EncryptedTicketPayload);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    encryptedPayloadVersion,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function decryptTicketPayload(
  value: string,
  ticket: string,
  viewerENameKey: string,
  encryptionKey: Buffer,
): EncryptedTicketPayload {
  const [version, ivValue, tagValue, ciphertextValue, ...rest] = value.split('.');
  if (
    version !== encryptedPayloadVersion ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue ||
    rest.length > 0
  ) {
    throw new Error('Recording concat ticket payload cannot be decrypted.');
  }
  try {
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    const ciphertext = Buffer.from(ciphertextValue, 'base64url');
    if (iv.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength === 0) {
      throw new Error('Invalid encrypted ticket payload.');
    }
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAAD(ticketAad(ticket, viewerENameKey));
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
    ) as unknown;
    return parseEncryptedTicketPayload(parsed);
  } catch {
    throw new Error('Recording concat ticket payload cannot be decrypted.');
  }
}

function parseEncryptedTicketPayload(value: unknown): EncryptedTicketPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Recording concat ticket payload is invalid.');
  }
  const payload = value as Record<string, unknown>;
  const segmentKey = payload.segmentKey;
  const correlationId = payload.correlationId;
  const eVaultUri = payload.eVaultUri;
  const initialAuthorizationReceipt = payload.initialAuthorizationReceipt;
  if (
    typeof segmentKey !== 'string' ||
    !opaqueTokenPattern.test(segmentKey) ||
    typeof correlationId !== 'string' ||
    !normalizeCorrelationId(correlationId) ||
    (eVaultUri !== undefined &&
      (typeof eVaultUri !== 'string' ||
        !eVaultUri.trim() ||
        eVaultUri.length > maxViewerEVaultUriLength ||
        eVaultUri.includes('\u0000'))) ||
    !isValidInitialAuthorizationReceipt(initialAuthorizationReceipt)
  ) {
    throw new Error('Recording concat ticket payload is invalid.');
  }
  const streamIds = parseStoredStreamIds(payload.streamIds);
  return {
    segmentKey,
    correlationId,
    ...(typeof eVaultUri === 'string' ? { eVaultUri: eVaultUri.trim() } : {}),
    streamIds,
    ...(typeof initialAuthorizationReceipt === 'string' ? { initialAuthorizationReceipt } : {}),
  };
}

function parseStoredStreamIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > maxRecordingSegments) {
    throw new Error('Recording concat ticket payload is invalid.');
  }
  const streamIds = value.map((streamId) => {
    if (
      typeof streamId !== 'string' ||
      !streamId.trim() ||
      streamId.length > maxStreamIdLength ||
      streamId.includes('\u0000')
    ) {
      throw new Error('Recording concat ticket payload is invalid.');
    }
    return streamId.trim();
  });
  if (
    new Set(streamIds).size !== streamIds.length ||
    recordingStreamIdsByteLength(streamIds) > maxTicketSourceBytes
  ) {
    throw new Error('Recording concat ticket payload is invalid.');
  }
  return streamIds;
}

function ticketAad(ticket: string, viewerENameKey: string): Buffer {
  return Buffer.from(`${encryptionContext}${ticket}\u0000${viewerENameKey}`, 'utf8');
}

function cloneTicket(record: RecordingTicket): RecordingTicket {
  return {
    ...record,
    viewer: { ...record.viewer },
    streamIds: [...record.streamIds],
  };
}

function normalizeViewer(viewer: RecordingTicketViewer): {
  viewer: RecordingTicketViewer;
  key: string;
} {
  const eName = viewer.eName.trim();
  if (!eName || eName.includes('\u0000')) {
    throw new RecordingConcatTicketError('This recording cannot be opened.', 'forbidden', 403);
  }
  const eVaultUri = viewer.eVaultUri?.trim();
  if (eVaultUri && (eVaultUri.length > maxViewerEVaultUriLength || eVaultUri.includes('\u0000'))) {
    throw new RecordingConcatTicketError('This recording cannot be opened.', 'forbidden', 403);
  }
  return {
    viewer: { eName, ...(eVaultUri ? { eVaultUri } : {}) },
    key: eName.toLowerCase(),
  };
}

function normalizeInitialAuthorizationReceipt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isValidInitialAuthorizationReceipt(value)) {
    throw new RecordingConcatTicketError(
      'This recording cannot be opened.',
      'invalid_recording',
      400,
    );
  }
  // Do not trim or otherwise reinterpret the opaque signed receipt. Its
  // eventual verifier must receive the exact server-generated wire value.
  return value;
}

function isValidInitialAuthorizationReceipt(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maxInitialAuthorizationReceiptLength &&
      !value.includes('\u0000'))
  );
}

function canReplaceSegment(
  record: RecordingTicket | undefined,
  segmentKey: string | null,
  streamIndex: number,
  streamId: string,
): record is RecordingTicket {
  if (
    !record?.claimed ||
    !sameOpaqueToken(record.segmentKey, segmentKey) ||
    streamIndex < 0 ||
    streamIndex >= record.streamIds.length
  ) {
    return false;
  }
  const replacedBytes =
    recordingStreamIdsByteLength(record.streamIds) -
    Buffer.byteLength(record.streamIds[streamIndex] ?? '') +
    Buffer.byteLength(streamId);
  return replacedBytes <= maxTicketSourceBytes;
}

function parseSegmentIndex(index: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(index)) throw unavailableSegmentError();
  const streamIndex = Number(index);
  if (!Number.isSafeInteger(streamIndex)) throw unavailableSegmentError();
  return streamIndex;
}

function requireOpaqueTicket(ticket: string): void {
  if (!opaqueTokenPattern.test(ticket)) throw unavailableTicketError();
}

function unavailableTicketError(): RecordingConcatTicketError {
  return new RecordingConcatTicketError('This recording is unavailable.', 'not_found', 404);
}

function unavailableSegmentError(): RecordingConcatTicketError {
  return new RecordingConcatTicketError('This recording segment is unavailable.', 'not_found', 404);
}

function parseInternalMediaOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RecordingConcatTicketError('The recording service is unavailable.', 'busy', 503);
  }
  // Do not use `localhost`: host overrides make it ambiguous. The loopback
  // literal prevents the private segment capability from traversing Caddy or
  // a public network route. WHATWG serializes IPv6 as `[::1]`.
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new RecordingConcatTicketError('The recording service is unavailable.', 'busy', 503);
  }
  return url;
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function normalizeRecordingStreamId(streamId: unknown): string {
  if (typeof streamId !== 'string') {
    throw new RecordingConcatTicketError(
      'This recording does not have a valid set of sources.',
      'invalid_recording',
      400,
    );
  }
  const normalized = streamId.trim();
  if (!normalized || normalized.length > maxStreamIdLength || normalized.includes('\u0000')) {
    throw new RecordingConcatTicketError(
      'This recording does not have a valid set of sources.',
      'invalid_recording',
      400,
    );
  }
  return normalized;
}

function recordingStreamIdsByteLength(streamIds: readonly string[]): number {
  return streamIds.reduce((total, streamId) => total + Buffer.byteLength(streamId), 0);
}

function sameViewer(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sameOpaqueToken(expected: string, value: string | null): boolean {
  if (!value || !opaqueTokenPattern.test(value)) return false;
  const expectedBytes = Buffer.from(expected);
  const valueBytes = Buffer.from(value);
  return (
    expectedBytes.byteLength === valueBytes.byteLength && timingSafeEqual(expectedBytes, valueBytes)
  );
}
