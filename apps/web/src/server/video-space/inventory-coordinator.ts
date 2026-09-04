import 'server-only';

import type { AuthUser } from '@w3ds/auth';
import {
  createMeshengerVideoLibrary,
  type MeshengerLibrary,
  type MeshengerVideo,
  type SharedSpaceAccess,
  type SharedSpaceProbe,
} from '../meshenger-video-library';
import { reportOperationalEvent } from '../ops-observability';
import { getW3dsAuthService } from '../w3ds-auth';
import type { InventoryCompleteness } from './completeness';
import { completeInventory } from './completeness';
import {
  emptySourceCounts,
  formatInventoryMetricsLog,
  type InventoryCacheOutcome,
  type InventoryDiscovery,
  type InventoryMetrics,
  type InventoryScanPhase,
  type InventoryScope,
  type InventorySourceCounts,
  inventoryDiscovery,
} from './discovery';
import { mapPool } from './map-pool';

const cacheTtlMs = 45_000;
const revalidateConcurrency = 4;
const sharedAccessProbeTimeoutMs = 3_000;
const sharedSourceNameTimeoutMs = 750;
// Keep a durable background pass short. The next pump resumes its exact queue,
// allowing interactive playback and deployments to preempt deep history scans.
const backgroundInventoryMaxWaves = 2;

export interface InventorySnapshot {
  items: MeshengerVideo[];
  conversations: MeshengerLibrary['conversations'];
  messages: MeshengerLibrary['messages'];
  completeness: InventoryCompleteness;
  discovery: InventoryDiscovery;
  scope: InventoryScope;
  metrics: InventoryMetrics;
}

export interface InventoryScanner {
  scanLibrary(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    options: {
      scope: InventoryScope;
      refresh?: boolean;
      drain?: boolean;
      maxWaves?: number;
      onSnapshot: (
        library: MeshengerLibrary,
        phase: InventoryScanPhase,
        counts: InventorySourceCounts,
      ) => void;
    },
  ): Promise<MeshengerLibrary>;
  probeSharedSpaceAccess(
    user: Pick<AuthUser, 'eName'>,
    space: SharedSpaceProbe,
  ): Promise<SharedSpaceAccess>;
}

interface CacheEntry {
  scope: InventoryScope;
  snapshot: MeshengerLibrary;
  scanning: boolean;
  inflight?: Promise<void>;
  firstReady: Promise<void>;
  resolveFirst: () => void;
  startedAt: number;
  firstResultAt?: number;
  completedAt?: number;
  sourceCounts: InventorySourceCounts;
  spaces: SharedSpaceProbe[];
  /** Per-viewer cache of safe, explicitly chosen source display names. */
  sharedSourceNames: Map<string, string>;
  resolvedSharedSourceNames: Set<string>;
  /** Shared cards whose current source probe is retryable, never denied. */
  checkingSharedItemIds: Set<string>;
  /** Emit at most one aggregate event while the same shared retry state persists. */
  sharedRetryReported: boolean;
}

export function publicLibraryItems(
  items: readonly MeshengerVideo[],
  sharedSourceNames: ReadonlyMap<string, string> = new Map(),
): MeshengerVideo[] {
  return items.map((item) => {
    const {
      sourceSpaceKey: _space,
      sourceChatId: _chat,
      sourceReferenceId: _reference,
      sourceReferenceFileId: _referenceFile,
      accessBasis: _basis,
      sharedBy: _untrustedSharedBy,
      ...publicItem
    } = item;
    if (item.accessScope !== 'shared') return publicItem;
    // A name is added only after the source passed its current authorization
    // check and only for a direct source whose owner deliberately chose a
    // public Vidak name. Group identifiers and all raw source metadata stay
    // server-only.
    const sharedBy =
      _basis === 'history' && _space ? sharedSourceNames.get(_space)?.trim() : undefined;
    return {
      ...publicItem,
      // This is deliberately source-type context, not a guessed person. The
      // source eName is private implementation metadata and must not cross the
      // API boundary.
      sharedVia: _basis === 'membership' ? 'group' : 'conversation',
      ...(sharedBy ? { sharedBy } : {}),
    };
  });
}

export function createInventoryCoordinator(options?: {
  createScanner?: () => InventoryScanner;
  now?: () => number;
  ttlMs?: number;
  revalidationTimeoutMs?: number;
  resolveSharedSourceNames?: (eNames: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  log?: (line: string) => void;
}) {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? cacheTtlMs;
  const revalidationTimeoutMs = options?.revalidationTimeoutMs ?? sharedAccessProbeTimeoutMs;
  const resolveSharedSourceNames =
    options?.resolveSharedSourceNames ??
    ((eNames: readonly string[]) => getW3dsAuthService().findChosenPublicNamesByENames(eNames));
  const log = options?.log ?? ((line: string) => console.info(line));
  const createScanner = options?.createScanner ?? (() => createMeshengerVideoLibrary());
  const entries = new Map<string, CacheEntry>();
  let scanner: InventoryScanner | undefined;
  let pumpChain: Promise<void> = Promise.resolve();
  let pumpFailureReported = false;

  function getScanner(): InventoryScanner {
    scanner ??= createScanner();
    return scanner;
  }

  function keyFor(eName: string, scope: InventoryScope): string {
    return `${eName}\u0000${scope}`;
  }

  function startScan(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    scope: InventoryScope,
    previous?: CacheEntry,
    refresh?: boolean,
  ): CacheEntry {
    let resolveFirst: () => void = () => undefined;
    const firstReady = new Promise<void>((resolve) => {
      resolveFirst = () => resolve();
    });
    const entry: CacheEntry = {
      scope,
      snapshot: previous?.snapshot ?? emptyLibrary(),
      scanning: true,
      firstReady,
      resolveFirst,
      startedAt: now(),
      sourceCounts: emptySourceCounts(),
      spaces: previous?.spaces ?? [],
      sharedSourceNames: previous?.sharedSourceNames ?? new Map(),
      resolvedSharedSourceNames: previous?.resolvedSharedSourceNames ?? new Set(),
      checkingSharedItemIds: previous?.checkingSharedItemIds ?? new Set(),
      sharedRetryReported: previous?.sharedRetryReported ?? false,
      ...(previous?.snapshot.items.length
        ? { firstResultAt: previous.firstResultAt ?? now() }
        : {}),
    };
    if (previous?.snapshot.items.length) entry.resolveFirst();

    const inflight = getScanner()
      .scanLibrary(user, {
        scope,
        drain: false,
        ...(refresh ? { refresh: true } : {}),
        onSnapshot: (library, phase, counts) => {
          entry.snapshot = mergeLibraries(entry.snapshot, library);
          entry.sourceCounts = counts;
          entry.spaces = spacesFromItems(entry.snapshot.items, scope);
          if (entry.firstResultAt === undefined) entry.firstResultAt = now();
          entry.resolveFirst();
          if (phase === 'done') {
            entry.scanning = false;
            entry.completedAt = now();
          }
        },
      })
      .then((library) => {
        entry.snapshot = mergeLibraries(entry.snapshot, library);
        entry.spaces = spacesFromItems(entry.snapshot.items, scope);
        entry.resolveFirst();
        // A bounded foreground pass can return a retryable partial snapshot.
        // It is no longer actively scanning once this call settles: mark it as
        // terminal for the cache/UI, retain the cards, and let an explicit
        // Refresh resume the durable job. Leaving this true makes every client
        // poll start another expensive private scan indefinitely.
        entry.scanning = false;
        entry.completedAt = now();
      })
      .catch(() => {
        entry.scanning = false;
        entry.completedAt = now();
        entry.resolveFirst();
      })
      .then(() => undefined);

    entry.inflight = inflight;
    entries.set(keyFor(user.eName, scope), entry);
    return entry;
  }

  async function serve(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    entry: CacheEntry,
    requestStarted: number,
    cache: InventoryCacheOutcome,
  ): Promise<InventorySnapshot> {
    if (entry.firstResultAt === undefined) await entry.firstReady;
    let snapshot = entry.snapshot;
    // Discovery establishes where a shared reference came from, but the card
    // must not offer playback until that source proves the viewer still has
    // access. Check fresh snapshots too: otherwise a first-load card can
    // briefly offer Watch and then be rejected by the media route.
    if (entry.scope === 'shared' || entry.scope === 'all') {
      snapshot = await revalidateShared(user, entry);
    }
    const discovery = inventoryDiscovery({
      scanning: entry.scanning,
      completeness: snapshot.completeness,
    });
    const waitMs = Math.max(0, now() - requestStarted);
    const metrics: InventoryMetrics = {
      cache,
      firstResultMs:
        cache === 'hit' ? waitMs : Math.max(0, (entry.firstResultAt ?? now()) - entry.startedAt),
      sourceCounts: { ...entry.sourceCounts },
      ...(entry.completedAt !== undefined
        ? { completionMs: Math.max(0, entry.completedAt - entry.startedAt) }
        : {}),
    };
    if (cache !== 'hit') metrics.firstResultMs = waitMs;
    log(
      formatInventoryMetricsLog({
        discovery,
        completeness: snapshot.completeness,
        metrics,
      }),
    );
    return {
      items: publicLibraryItems(
        snapshot.items,
        await sharedSourceNamesFor(snapshot.items, entry),
      ).map((item) =>
        entry.checkingSharedItemIds.has(item.id)
          ? // A transient source probe must never turn an already-discovered,
            // viewer-bound share into a dead card. The media route repeats the
            // authorization check when Watch is opened (and for every media
            // request), which is the enforcement point. Keep the opaque grant
            // so a retryable catalogue check cannot remove the only action.
            { ...item, sourceAccess: 'checking' as const }
          : item,
      ),
      conversations: snapshot.conversations,
      messages: snapshot.messages,
      completeness: snapshot.completeness,
      discovery,
      scope: entry.scope,
      metrics,
    };
  }

  async function sharedSourceNamesFor(
    items: readonly MeshengerVideo[],
    entry: CacheEntry,
  ): Promise<ReadonlyMap<string, string>> {
    const eNames = [
      ...new Set(
        items
          .filter(
            (item) =>
              item.accessScope === 'shared' &&
              item.accessBasis === 'history' &&
              Boolean(item.sourceSpaceKey),
          )
          .map((item) => item.sourceSpaceKey as string)
          .filter((eName) => !entry.resolvedSharedSourceNames.has(eName)),
      ),
    ];
    if (eNames.length === 0) return entry.sharedSourceNames;
    try {
      const resolved = await withTimeout(
        resolveSharedSourceNames(eNames),
        sharedSourceNameTimeoutMs,
      );
      for (const eName of eNames) {
        entry.resolvedSharedSourceNames.add(eName);
        const name = resolved.get(eName)?.trim();
        if (name) entry.sharedSourceNames.set(eName, name);
      }
    } catch {
      // Attribution must never delay or block a verified private library.
      // Leave unresolved names uncached so a later response can retry.
    }
    return entry.sharedSourceNames;
  }

  async function revalidateShared(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    entry: CacheEntry,
  ): Promise<MeshengerLibrary> {
    if (entry.spaces.length === 0) return entry.snapshot;
    const accessBySpace = new Map<string, SharedSpaceAccess>();
    await mapPool(entry.spaces, revalidateConcurrency, async (space) => {
      try {
        accessBySpace.set(
          sharedSpaceProbeKey(space),
          await withTimeout(
            getScanner().probeSharedSpaceAccess(user, space),
            revalidationTimeoutMs,
          ),
        );
      } catch {
        accessBySpace.set(sharedSpaceProbeKey(space), { access: 'retry', member: false });
      }
    });
    const outcomes = new Map<string, SharedItemAccess>();
    for (const item of entry.snapshot.items) {
      if (item.accessScope !== 'shared') continue;
      outcomes.set(item.id, sharedItemAccess(item, accessBySpace));
    }
    if ([...outcomes.values()].every((outcome) => outcome === 'verified')) {
      entry.checkingSharedItemIds.clear();
      entry.sharedRetryReported = false;
      return entry.snapshot;
    }
    entry.checkingSharedItemIds = new Set(
      [...outcomes].flatMap(([itemId, outcome]) => (outcome === 'retry' ? [itemId] : [])),
    );
    const items = entry.snapshot.items.filter((item) => {
      const outcome = outcomes.get(item.id);
      return outcome === undefined || outcome === 'verified' || outcome === 'retry';
    });
    const denied = [...outcomes.values()].filter((outcome) => outcome === 'denied').length;
    const missing = [...outcomes.values()].filter((outcome) => outcome === 'missing').length;
    const unavailable = [...outcomes.values()].filter((outcome) => outcome === 'retry').length;
    if (unavailable > 0 && !entry.sharedRetryReported) {
      reportOperationalEvent({ category: 'video_library', code: 'shared_source_recheck_deferred' });
      entry.sharedRetryReported = true;
    } else if (unavailable === 0) {
      entry.sharedRetryReported = false;
    }
    const completeness = {
      ...entry.snapshot.completeness,
      denied: entry.snapshot.completeness.denied + denied,
      missing: entry.snapshot.completeness.missing + missing,
      ...(unavailable > 0
        ? {
            complete: false,
            retryNeeded: true,
            deferred: Math.max(entry.snapshot.completeness.deferred ?? 0, unavailable),
          }
        : {}),
    };
    const next = { ...entry.snapshot, items, completeness };
    entry.snapshot = next;
    entry.spaces = spacesFromItems(items, 'shared');
    return next;
  }

  async function pumpOnce(): Promise<void> {
    try {
      const { getInventoryJobStore } = await import('./job-store');
      const store = getInventoryJobStore();
      await store.recoverStaleLocks(now());
      const running = await store.listRunning();
      for (const job of running) {
        const key = keyFor(job.ownerEName, 'all');
        const previous = entries.get(key);
        let resolveFirst = previous?.resolveFirst ?? (() => undefined);
        const firstReady =
          previous?.firstReady ??
          new Promise<void>((resolve) => {
            resolveFirst = () => resolve();
          });
        const entry: CacheEntry = previous ?? {
          scope: 'all',
          snapshot: emptyLibrary(),
          scanning: true,
          firstReady,
          resolveFirst,
          startedAt: now(),
          sourceCounts: emptySourceCounts(),
          spaces: [],
          sharedSourceNames: new Map(),
          resolvedSharedSourceNames: new Set(),
          checkingSharedItemIds: new Set(),
          sharedRetryReported: false,
        };
        if (!previous) {
          entry.scanning = true;
          entries.set(key, entry);
        }
        await getScanner().scanLibrary(
          { eName: job.ownerEName, eVaultUri: job.ownerEVaultUri },
          {
            scope: 'all',
            drain: true,
            maxWaves: backgroundInventoryMaxWaves,
            onSnapshot: (library, phase, counts) => {
              entry.snapshot = mergeLibraries(entry.snapshot, library);
              entry.sourceCounts = counts;
              entry.spaces = spacesFromItems(entry.snapshot.items, 'all');
              if (entry.firstResultAt === undefined) entry.firstResultAt = now();
              entry.resolveFirst();
              if (phase === 'done' || library.completeness.complete) {
                entry.scanning = false;
                entry.completedAt = now();
              } else {
                entry.scanning = true;
              }
            },
          },
        );
        // This pump wave is bounded too. A persisted job may remain for a
        // later explicit refresh, but the finished wave must not advertise an
        // active scan and cause the browser to hammer the private library.
        entry.scanning = false;
        entry.completedAt = now();
      }
      pumpFailureReported = false;
    } catch {
      // Keep the process alive, but do not make a broken production pump
      // invisible. The event intentionally contains no error message, account,
      // source, URI, or other private metadata, and is emitted once per outage.
      if (!pumpFailureReported) {
        log('[inventory-pump] failed');
        reportOperationalEvent({ category: 'video_library', code: 'background_pump_failed' });
      }
      pumpFailureReported = true;
    }
  }

  function pumpRunning(): Promise<void> {
    const next = pumpChain.then(pumpOnce, pumpOnce);
    pumpChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    async getSnapshot(
      user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
      input: { scope: InventoryScope; refresh?: boolean },
    ): Promise<InventorySnapshot> {
      const requestStarted = now();
      const key = keyFor(user.eName, input.scope);
      let entry = entries.get(key);

      if (input.refresh) {
        if (entry?.inflight && entry.scanning) {
          void pumpRunning();
          return serve(user, entry, requestStarted, 'coalesced');
        }
        entry = startScan(user, input.scope, entry, true);
        void pumpRunning();
        return serve(user, entry, requestStarted, 'miss');
      }

      if (entry?.inflight && entry.scanning) {
        void pumpRunning();
        return serve(user, entry, requestStarted, 'coalesced');
      }

      if (entry && !entry.scanning && entry.completedAt && now() - entry.completedAt < ttlMs) {
        // A soft partial snapshot is still useful. Keep it warm for the TTL;
        // users can explicitly Refresh to resume its persisted job instead of
        // each browser poll restarting private discovery work.
        return serve(user, entry, requestStarted, 'hit');
      }

      entry = startScan(user, input.scope, entry);
      void pumpRunning();
      return serve(user, entry, requestStarted, 'miss');
    },

    /** Test helper: current in-memory keys, never tokens. */
    size() {
      return entries.size;
    },

    reset() {
      entries.clear();
      scanner = undefined;
      pumpChain = Promise.resolve();
      pumpFailureReported = false;
    },

    /** Continues persisted jobs without an open browser tab. */
    pumpRunning,
  };
}

export type InventoryCoordinator = ReturnType<typeof createInventoryCoordinator>;

let coordinator: InventoryCoordinator | undefined;

export function getInventoryCoordinator(): InventoryCoordinator {
  coordinator ??= createInventoryCoordinator();
  return coordinator;
}

export function resetInventoryCoordinatorForTests(): void {
  coordinator?.reset();
  coordinator = undefined;
}

function emptyLibrary(): MeshengerLibrary {
  return {
    items: [],
    conversations: [],
    messages: [],
    completeness: completeInventory,
  };
}

function mergeLibraries(previous: MeshengerLibrary, next: MeshengerLibrary): MeshengerLibrary {
  const items = new Map(previous.items.map((item) => [item.id, item]));
  for (const item of next.items) items.set(item.id, item);
  const conversations = new Map(previous.conversations.map((item) => [item.id, item]));
  for (const item of next.conversations) conversations.set(item.id, item);
  const messages = new Map(previous.messages.map((item) => [item.id, item]));
  for (const item of next.messages) messages.set(item.id, item);
  return {
    items: [...items.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    conversations: [...conversations.values()],
    messages: [...messages.values()],
    completeness: next.completeness,
  };
}

function withTimeout<T>(value: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out.')), timeoutMs);
    void value.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function spacesFromItems(
  items: readonly MeshengerVideo[],
  scope: InventoryScope,
): SharedSpaceProbe[] {
  if (scope !== 'shared' && scope !== 'all') return [];
  const unique = new Map<string, SharedSpaceProbe>();
  for (const item of items) {
    for (const probe of sharedItemProbes(item)) unique.set(sharedSpaceProbeKey(probe), probe);
  }
  return [...unique.values()];
}

type SharedItemAccess = 'verified' | 'denied' | 'missing' | 'retry';

function sharedItemAccess(
  item: MeshengerVideo,
  accessBySpace: ReadonlyMap<string, SharedSpaceAccess>,
): SharedItemAccess {
  const accesses = sharedItemProbes(item)
    .map((probe) => accessBySpace.get(sharedSpaceProbeKey(probe)))
    .filter((access): access is SharedSpaceAccess => access !== undefined);
  if (accesses.some((access) => access.access === 'ok' && access.member)) return 'verified';
  if (accesses.some((access) => access.access === 'retry')) return 'retry';
  if (accesses.length > 0 && accesses.every((access) => access.access === 'missing'))
    return 'missing';
  return 'denied';
}

/** Mirrors the authorization alternatives checked by the private media route. */
function sharedItemProbes(item: MeshengerVideo): SharedSpaceProbe[] {
  if (item.accessScope !== 'shared' || !item.sourceSpaceKey) return [];
  if (item.accessBasis === 'membership') {
    return [{ eName: item.sourceSpaceKey, kind: 'group' }];
  }
  if (item.accessBasis === 'reference' && item.sourceReferenceId && item.sourceReferenceFileId) {
    return [
      {
        eName: item.sourceSpaceKey,
        kind: 'reference',
        referenceId: item.sourceReferenceId,
        fileId: item.sourceReferenceFileId,
      },
    ];
  }
  if (item.accessBasis === 'history' && item.sourceChatId) {
    return [
      { eName: item.sourceSpaceKey, kind: 'direct', chatId: item.sourceChatId },
      { eName: item.sourceSpaceKey, kind: 'group' },
    ];
  }
  return [];
}

function sharedSpaceProbeKey(space: SharedSpaceProbe): string {
  return `${space.kind}\u0000${space.eName}\u0000${
    space.kind === 'direct' ? space.chatId : ''
  }\u0000${space.kind === 'reference' ? space.referenceId : ''}\u0000${
    space.kind === 'reference' ? space.fileId : ''
  }`;
}
