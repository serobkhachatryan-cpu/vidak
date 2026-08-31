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
    const { sourceSpaceKey: _space, accessBasis: _basis, ...publicItem } = item;
    return publicItem;
  });
}

export function createInventoryCoordinator(options?: {
  createScanner?: () => InventoryScanner;
  now?: () => number;
  ttlMs?: number;
  log?: (line: string) => void;
}) {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? cacheTtlMs;
  const log = options?.log ?? ((line: string) => console.info(line));
  const createScanner = options?.createScanner ?? (() => createMeshengerVideoLibrary());
  const entries = new Map<string, CacheEntry>();
  let scanner: InventoryScanner | undefined;
  let pumpChain: Promise<void> = Promise.resolve();

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
    if (!entry.scanning && (entry.scope === 'shared' || entry.scope === 'all')) {
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
    const denied = new Set<string>();
    const missing = new Set<string>();
    const nonMember = new Set<string>();
    await mapPool(entry.spaces, revalidateConcurrency, async (space) => {
      const result = await getScanner().probeSharedSpaceAccess(user, space);
      if (result.access === 'denied') denied.add(space.eName);
      else if (result.access === 'missing') missing.add(space.eName);
      else if (result.access === 'ok' && !result.member && space.kind === 'group') {
        nonMember.add(space.eName);
      }
    });
    if (denied.size === 0 && missing.size === 0 && nonMember.size === 0) return entry.snapshot;
    const items = entry.snapshot.items.filter((item) => {
      const space = item.sourceSpaceKey;
      if (!space) return true;
      if (denied.has(space) || missing.has(space)) return false;
      if (nonMember.has(space) && item.accessBasis === 'membership') return false;
      return true;
    });
    const completeness = {
      ...entry.snapshot.completeness,
      denied: entry.snapshot.completeness.denied + denied.size,
      missing: entry.snapshot.completeness.missing + missing.size,
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
    } catch {
      // Pump must never crash the Node process.
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

function spacesFromItems(
  items: readonly MeshengerVideo[],
  scope: InventoryScope,
): SharedSpaceProbe[] {
  if (scope !== 'shared' && scope !== 'all') return [];
  const unique = new Map<string, SharedSpaceProbe>();
  for (const item of items) {
    if (!item.sourceSpaceKey || item.accessBasis !== 'membership') continue;
    unique.set(item.sourceSpaceKey, { eName: item.sourceSpaceKey, kind: 'group' });
  }
  for (const item of items) {
    if (!item.sourceSpaceKey || unique.has(item.sourceSpaceKey)) continue;
    unique.set(item.sourceSpaceKey, { eName: item.sourceSpaceKey, kind: 'direct' });
  }
  return [...unique.values()];
}
