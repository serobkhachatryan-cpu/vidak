import 'server-only';

import type { AuthUser } from '@w3ds/auth';
import {
  createMeshengerVideoLibrary,
  type MeshengerLibrary,
  type MeshengerVideo,
  type SharedSpaceAccess,
  type SharedSpaceProbe,
} from '../meshenger-video-library';
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
}

export function publicLibraryItems(items: readonly MeshengerVideo[]): MeshengerVideo[] {
  return items.map((item) => {
    const {
      sourceSpaceKey: _space,
      sourceChatId: _chat,
      accessBasis: _basis,
      ...publicItem
    } = item;
    if (item.accessScope !== 'shared') return publicItem;
    return {
      ...publicItem,
      // This is deliberately source-type context, not a guessed person. The
      // source eName is private implementation metadata and must not cross the
      // API boundary.
      sharedVia: _basis === 'membership' ? 'group' : 'conversation',
    };
  });
}

export function createInventoryCoordinator(options?: {
  createScanner?: () => InventoryScanner;
  now?: () => number;
  ttlMs?: number;
  revalidationTimeoutMs?: number;
  log?: (line: string) => void;
}) {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? cacheTtlMs;
  const revalidationTimeoutMs = options?.revalidationTimeoutMs ?? sharedAccessProbeTimeoutMs;
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
        if (library.completeness.complete) {
          entry.scanning = false;
          entry.completedAt = now();
        }
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
      items: publicLibraryItems(snapshot.items),
      conversations: snapshot.conversations,
      messages: snapshot.messages,
      completeness: snapshot.completeness,
      discovery,
      scope: entry.scope,
      metrics,
    };
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
      return entry.snapshot;
    }
    const items = entry.snapshot.items.filter((item) => {
      const outcome = outcomes.get(item.id);
      return outcome === undefined || outcome === 'verified';
    });
    const denied = [...outcomes.values()].filter((outcome) => outcome === 'denied').length;
    const missing = [...outcomes.values()].filter((outcome) => outcome === 'missing').length;
    const unavailable = [...outcomes.values()].filter((outcome) => outcome === 'retry').length;
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
      }
      pumpFailureReported = false;
    } catch {
      // Keep the process alive, but do not make a broken production pump
      // invisible. The event intentionally contains no error message, account,
      // source, URI, or other private metadata, and is emitted once per outage.
      if (!pumpFailureReported) log('[inventory-pump] failed');
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
        const discovery = inventoryDiscovery({
          scanning: false,
          completeness: entry.snapshot.completeness,
        });
        if (discovery === 'complete') {
          return serve(user, entry, requestStarted, 'hit');
        }
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
  if (item.accessBasis === 'history' && item.sourceChatId) {
    return [
      { eName: item.sourceSpaceKey, kind: 'direct', chatId: item.sourceChatId },
      { eName: item.sourceSpaceKey, kind: 'group' },
    ];
  }
  return [];
}

function sharedSpaceProbeKey(space: SharedSpaceProbe): string {
  return `${space.kind}\u0000${space.eName}\u0000${space.chatId ?? ''}`;
}
