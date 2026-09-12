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
import { backgroundWorkDelayMs, beginBackgroundWork } from './background-work-priority';
import type { InventoryCompleteness } from './completeness';
import { completeInventory, inventoryJobNeedsDrain } from './completeness';
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
import { coalesceSharedAccessProbe } from './shared-access-cache';

const cacheTtlMs = 45_000;
// Shared source checks are background metadata work. Keep this below the
// inventory fan-out so they cannot saturate the same small eVault that an
// interactive Watch request is trying to open, while preserving paired
// conversation/group fallback checks.
const revalidateConcurrency = 2;
const sharedAccessProbeTimeoutMs = 3_000;
// Listing a private library must not turn every browser refresh into another
// full round of remote eVault authorization reads. Playback is still checked
// independently at the media route; this short cache only keeps catalogue
// metadata responsive between those checks.
const sharedAccessCacheTtlMs = 30_000;
const sharedAccessRetryCacheTtlMs = 5_000;
const sharedSourceNameTimeoutMs = 750;
// Keep a durable background pass very short. The next pump resumes its exact
// queue, allowing interactive playback and deployments to preempt deep
// history scans on the same host.
const backgroundInventoryMaxWaves = 1;
const backgroundInventoryMaxVaultsPerWave = 2;

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
      maxVaultsPerWave?: number;
      signal?: AbortSignal;
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
    rateLimit?: 'fail-fast' | 'backoff',
    options?: { signal?: AbortSignal },
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
  /** Short-lived authorization results for catalogue cards, keyed by source probe. */
  sharedAccess: Map<string, CachedSharedSpaceAccess>;
  /** Per-viewer cache of safe, explicitly chosen source display names. */
  sharedSourceNames: Map<string, string>;
  resolvedSharedSourceNames: Set<string>;
  /** Shared cards whose current source probe is retryable, never denied. */
  checkingSharedItemIds: Set<string>;
  /** One background recheck; never make the private catalogue wait for it. */
  sharedRevalidation: Promise<void> | undefined;
  /** Emit at most one aggregate event while the same shared retry state persists. */
  sharedRetryReported: boolean;
  /** Source attribution is decorative and must stay off the first-card path. */
  sharedSourceNamesInflight: Promise<void> | undefined;
}

interface CachedSharedSpaceAccess {
  value: SharedSpaceAccess;
  checkedAt: number;
}

export function publicLibraryItems(
  items: readonly MeshengerVideo[],
  sharedSourceNames: ReadonlyMap<string, string> = new Map(),
): MeshengerVideo[] {
  return items.map((item) => {
    const {
      sourceSpaceKey: _space,
      sourceChatId: _chat,
      sourceViewerChatGrantId: _viewerChatGrant,
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
  sharedAccessCacheTtlMs?: number;
  resolveSharedSourceNames?: (eNames: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  log?: (line: string) => void;
}) {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? cacheTtlMs;
  const revalidationTimeoutMs = options?.revalidationTimeoutMs ?? sharedAccessProbeTimeoutMs;
  const cachedSharedAccessTtlMs = options?.sharedAccessCacheTtlMs ?? sharedAccessCacheTtlMs;
  const resolveSharedSourceNames =
    options?.resolveSharedSourceNames ??
    ((eNames: readonly string[]) => getW3dsAuthService().findChosenPublicNamesByENames(eNames));
  const log = options?.log ?? ((line: string) => console.info(line));
  const createScanner = options?.createScanner ?? (() => createMeshengerVideoLibrary());
  const entries = new Map<string, CacheEntry>();
  let scanner: InventoryScanner | undefined;
  let activePump: Promise<void> | undefined;
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
      sharedAccess: previous?.sharedAccess ?? new Map(),
      sharedSourceNames: previous?.sharedSourceNames ?? new Map(),
      resolvedSharedSourceNames: previous?.resolvedSharedSourceNames ?? new Set(),
      checkingSharedItemIds: previous?.checkingSharedItemIds ?? new Set(),
      sharedRevalidation: undefined,
      sharedRetryReported: previous?.sharedRetryReported ?? false,
      sharedSourceNamesInflight: undefined,
      ...(previous?.snapshot.items.length
        ? { firstResultAt: previous.firstResultAt ?? now() }
        : {}),
    };
    if (previous?.snapshot.items.length) entry.resolveFirst();

    // A cache miss only seeds/resumes durable inventory; it is not part of
    // the Watch request. Let an explicit player opening preempt even this
    // small foreground checkpoint so its directory read cannot compete with
    // a source proof on the constrained production worker. The checkpoint is
    // resumable, and a preempted entry is deliberately eligible to retry on
    // the next catalogue poll rather than being cached as an empty result.
    const backgroundWork = beginBackgroundWork();
    const inflight = getScanner()
      .scanLibrary(user, {
        scope,
        drain: false,
        signal: backgroundWork.signal,
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
      .then(async (library) => {
        entry.snapshot = mergeLibraries(entry.snapshot, library);
        entry.spaces = spacesFromItems(entry.snapshot.items, scope);
        entry.resolveFirst();
        if (backgroundWork.signal.aborted) {
          // Do not retain a cancelled, possibly empty cache-miss snapshot for
          // the normal TTL. Its durable work will be picked up after playback
          // and the next catalogue request can start a fresh checkpoint.
          entry.scanning = false;
          delete entry.completedAt;
          return;
        }
        // The foreground request only seeds a durable job. Its promise can
        // settle after one checkpoint while the persisted queue still has
        // hundreds of pages to resume. Read the job state before deciding the
        // UI is terminal; otherwise the client stops its low-frequency
        // progress polling and newly indexed shared cards remain invisible
        // until a manual refresh or navigation.
        const needsDrain = await durableInventoryNeedsDrain(user.eName);
        if (needsDrain === true) {
          entry.scanning = true;
          delete entry.completedAt;
        } else if (needsDrain === false) {
          entry.scanning = false;
          entry.completedAt = now();
        }
      })
      .catch(() => {
        entry.scanning = false;
        if (backgroundWork.signal.aborted) delete entry.completedAt;
        else entry.completedAt = now();
        entry.resolveFirst();
      })
      .finally(() => {
        backgroundWork.release();
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
    // A shared source recheck can need several remote eVault pages. Preserve
    // the previously discovered viewer-bound card and recheck in the
    // background instead of making the catalogue (or every Watch click) wait
    // for all sources. The media route remains the authoritative byte-access
    // enforcement point.
    if (entry.scope === 'shared' || entry.scope === 'all') {
      scheduleSharedRevalidation(user, entry);
    }
    const snapshot = entry.snapshot;
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
    scheduleSharedSourceNames(snapshot.items, entry);
    const checkingSharedItemIds = new Set(entry.checkingSharedItemIds);
    for (const item of snapshot.items) {
      if (sharedItemNeedsRevalidation(item, entry, now(), cachedSharedAccessTtlMs)) {
        checkingSharedItemIds.add(item.id);
      }
    }
    return {
      items: publicLibraryItems(snapshot.items, entry.sharedSourceNames).map((item) =>
        checkingSharedItemIds.has(item.id)
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

  function scheduleSharedSourceNames(items: readonly MeshengerVideo[], entry: CacheEntry): void {
    if (entry.sharedSourceNamesInflight) return;
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
    if (eNames.length === 0) return;
    entry.sharedSourceNamesInflight = withTimeout(
      Promise.resolve().then(() => resolveSharedSourceNames(eNames)),
      sharedSourceNameTimeoutMs,
    )
      .then((resolved) => {
        for (const eName of eNames) {
          entry.resolvedSharedSourceNames.add(eName);
          const name = resolved.get(eName)?.trim();
          if (name) entry.sharedSourceNames.set(eName, name);
        }
      })
      .catch(() => {
        // Attribution must never delay or block a verified private library.
        // Leave unresolved names uncached so a later response can retry.
      })
      .finally(() => {
        entry.sharedSourceNamesInflight = undefined;
      });
  }

  function scheduleSharedRevalidation(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    entry: CacheEntry,
  ): void {
    if (entry.sharedRevalidation || !hasStaleSharedAccess(entry, now(), cachedSharedAccessTtlMs)) {
      return;
    }
    let pending: Promise<void>;
    pending = revalidateShared(user, entry)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (entry.sharedRevalidation === pending) entry.sharedRevalidation = undefined;
      });
    entry.sharedRevalidation = pending;
  }

  async function revalidateShared(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    entry: CacheEntry,
  ): Promise<MeshengerLibrary> {
    if (entry.spaces.length === 0) return entry.snapshot;
    const accessBySpace = new Map<string, SharedSpaceAccess>();
    const checkedAt = now();
    const probes = entry.spaces.filter((space) => {
      const key = sharedSpaceProbeKey(space);
      const cached = entry.sharedAccess.get(key);
      if (cached && sharedAccessIsFresh(cached, checkedAt, cachedSharedAccessTtlMs)) {
        accessBySpace.set(key, cached.value);
        return false;
      }
      return true;
    });
    await mapPool(probes, revalidateConcurrency, async (space) => {
      const key = sharedSpaceProbeKey(space);
      // A catalogue recheck is resumable. Register it with the same playback
      // priority coordinator as poster extraction so an explicit Watch can
      // stop a slow source-authorization read instead of competing with it.
      // The card remains visible and retries later; the media route performs
      // its own authoritative source check before it ever opens video bytes.
      const backgroundWork = beginBackgroundWork(space.eName);
      let access: SharedSpaceAccess;
      try {
        access = await withAbortTimeout(
          (timeoutSignal) =>
            coalesceSharedAccessProbe(
              user.eName,
              space,
              () =>
                getScanner().probeSharedSpaceAccess(user, space, 'fail-fast', {
                  signal: AbortSignal.any([timeoutSignal, backgroundWork.signal]),
                }),
              checkedAt,
              now,
              { priority: 'background' },
            ),
          revalidationTimeoutMs,
        );
      } catch {
        access = { access: 'retry', member: false };
      } finally {
        backgroundWork.release();
      }
      accessBySpace.set(key, access);
      entry.sharedAccess.set(key, { value: access, checkedAt });
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
    // Discovery is a catalogue concern; a later probe is not allowed to make
    // cards disappear. The probe can be incomplete or read an older source
    // mirror even while the viewer's existing, signed grant remains valid.
    // Playback itself always repeats the authoritative source check before
    // any video bytes are opened, so keeping the card does not grant access.
    const items = entry.snapshot.items;
    const unavailable = [...outcomes.values()].filter((outcome) => outcome === 'retry').length;
    if (unavailable > 0 && !entry.sharedRetryReported) {
      reportOperationalEvent({ category: 'video_library', code: 'shared_source_recheck_deferred' });
      entry.sharedRetryReported = true;
    } else if (unavailable === 0) {
      entry.sharedRetryReported = false;
    }
    const completeness = {
      ...entry.snapshot.completeness,
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
    entry.spaces = spacesFromItems(items, entry.scope);
    pruneSharedAccess(entry);
    return next;
  }

  async function pumpOnce(): Promise<void> {
    try {
      // Durable inventory is resumable. Do not start a new remote scan while
      // a viewer is opening a video: on the small production host even an
      // unrelated vault scan consumes the one CPU allocation and its own
      // source sockets. The next timer tick resumes the persisted queue, so
      // this postpones no cards permanently and never changes access rules.
      if (backgroundWorkDelayMs() > 0) return;
      const { getInventoryJobStore } = await import('./job-store');
      const store = getInventoryJobStore();
      await store.recoverStaleLocks(now());
      const running = await store.listRunning();
      for (const job of running) {
        // A Watch can begin while the lightweight job lookup is in flight.
        // Recheck before this worker starts a potentially slow eVault page.
        if (backgroundWorkDelayMs() > 0) return;
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
          sharedAccess: new Map(),
          sharedSourceNames: new Map(),
          resolvedSharedSourceNames: new Set(),
          checkingSharedItemIds: new Set(),
          sharedRevalidation: undefined,
          sharedRetryReported: false,
          sharedSourceNamesInflight: undefined,
        };
        if (!previous) {
          entry.scanning = true;
          entries.set(key, entry);
        }
        // One lease covers the whole durable job wave, including its source
        // reads. A Watch reservation aborts this work immediately; the scanner
        // checkpoints its untouched cursor and returns a normal batch so the
        // next pump can resume it without changing cards or access state.
        const backgroundWork = beginBackgroundWork();
        try {
          const library = await getScanner().scanLibrary(
            { eName: job.ownerEName, eVaultUri: job.ownerEVaultUri },
            {
              scope: 'all',
              drain: true,
              maxWaves: backgroundInventoryMaxWaves,
              maxVaultsPerWave: backgroundInventoryMaxVaultsPerWave,
              signal: backgroundWork.signal,
              onSnapshot: (library, phase, counts) => {
                entry.snapshot = mergeLibraries(entry.snapshot, library);
                entry.sourceCounts = counts;
                entry.spaces = spacesFromItems(entry.snapshot.items, 'all');
                if (entry.firstResultAt === undefined) entry.firstResultAt = now();
                entry.resolveFirst();
                if (phase === 'done') {
                  entry.scanning = false;
                  entry.completedAt = now();
                } else {
                  entry.scanning = true;
                }
              },
            },
          );
          entry.snapshot = mergeLibraries(entry.snapshot, library);
          entry.spaces = spacesFromItems(entry.snapshot.items, 'all');
          entry.resolveFirst();
          // `maxWaves` deliberately yields long scans. The database—not the
          // completion of this one worker call—is authoritative for whether
          // another wave remains. Keeping this true causes only a 15s progress
          // poll; it does not restart discovery because the process pump resumes
          // the same checkpointed queue.
          const current = await store.getByOwner(job.ownerEName);
          if (current && inventoryJobNeedsDrain(current)) {
            entry.scanning = true;
            delete entry.completedAt;
          } else {
            entry.scanning = false;
            entry.completedAt = now();
          }
        } finally {
          backgroundWork.release();
        }
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
    // The timer and library polling can both ask for a drain. Coalesce those
    // requests instead of queuing waves behind one another: an otherwise
    // harmless 750 ms timer used to let a slow eVault scan catch up in a
    // burst, starving an interactive source open.
    if (activePump) return activePump;
    let current: Promise<void>;
    current = pumpOnce()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (activePump === current) activePump = undefined;
      });
    activePump = current;
    return current;
  }

  async function durableInventoryNeedsDrain(eName: string): Promise<boolean | undefined> {
    try {
      const { getInventoryJobStore } = await import('./job-store');
      const job = await getInventoryJobStore().getByOwner(eName);
      return job ? inventoryJobNeedsDrain(job) : false;
    } catch {
      // The first result remains useful even if persistence is temporarily
      // unavailable. The process-level pump will retry independently.
      return undefined;
    }
  }

  async function getSnapshot(
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
  }

  function exactEntryIsFresh(entry: CacheEntry): boolean {
    // A running entry can contain a useful partial snapshot. A completed one
    // is only reused for the same short window as getSnapshot(), after which
    // the durable card (or ordinary scan fallback) is authoritative.
    return entry.scanning || (entry.completedAt !== undefined && now() - entry.completedAt < ttlMs);
  }

  function itemMatchesScope(item: MeshengerVideo, scope: InventoryScope): boolean {
    if (scope === 'all') return true;
    return scope === 'owned' ? item.accessScope === 'personal' : item.accessScope === 'shared';
  }

  function publicExactItem(item: MeshengerVideo, entry?: CacheEntry): MeshengerVideo | undefined {
    const publicItem = publicLibraryItems([item], entry?.sharedSourceNames)[0];
    if (!publicItem) return undefined;
    if (
      entry &&
      (entry.checkingSharedItemIds.has(item.id) ||
        sharedItemNeedsRevalidation(item, entry, now(), cachedSharedAccessTtlMs))
    ) {
      // This does not trigger a revalidation: Watch is interactive and its
      // media route performs the authoritative source proof. Preserve the
      // existing catalogue state if a background check was already pending.
      return { ...publicItem, sourceAccess: 'checking' };
    }
    return publicItem;
  }

  function exactItemFromMemory(
    user: Pick<AuthUser, 'eName'>,
    itemId: string,
    scope: InventoryScope,
  ): MeshengerVideo | undefined {
    const scopes: InventoryScope[] = scope === 'all' ? ['all', 'owned', 'shared'] : [scope];
    for (const candidateScope of scopes) {
      const entry = entries.get(keyFor(user.eName, candidateScope));
      if (!entry || !exactEntryIsFresh(entry)) continue;
      const item = entry.snapshot.items.find(
        (candidate) => candidate.id === itemId && itemMatchesScope(candidate, scope),
      );
      if (!item) continue;
      return publicExactItem(item, entry);
    }
    return undefined;
  }

  async function getItem(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    input: { itemId: string; scope: InventoryScope; refresh?: boolean },
  ): Promise<MeshengerVideo | undefined> {
    // An explicit refresh retains its existing semantics: bypass all retained
    // cards and rebuild the viewer-authorized inventory snapshot. Ordinary
    // Watch opens first use a bounded, exact memory/DB lookup and never start
    // a source scan when a current card already exists.
    if (!input.refresh) {
      const inMemory = exactItemFromMemory(user, input.itemId, input.scope);
      if (inMemory) return inMemory;

      try {
        const { getInventoryJobStore } = await import('./job-store');
        const persisted = await getInventoryJobStore().getItemByOwner(user.eName, input.itemId);
        if (persisted && itemMatchesScope(persisted, input.scope)) {
          const publicItem = publicExactItem(persisted);
          if (publicItem) return publicItem;
        }
      } catch {
        // A persistence outage must not make an otherwise valid Watch card
        // disappear. The normal coordinator path below can still seed or use
        // an in-memory viewer-authorized snapshot.
      }
    }

    const snapshot = await getSnapshot(user, {
      scope: input.scope,
      ...(input.refresh === true ? { refresh: true } : {}),
    });
    return snapshot.items.find((item) => item.id === input.itemId);
  }

  return {
    getSnapshot,
    getItem,

    /** Test helper: current in-memory keys, never tokens. */
    size() {
      return entries.size;
    },

    reset() {
      entries.clear();
      scanner = undefined;
      activePump = undefined;
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

/**
 * Catalogue revalidation is deliberately bounded, but an ordinary timeout
 * only stops awaiting a promise; the source request would continue to occupy
 * the eVault long after the card had moved on. Abort the underlying probe as
 * well, so `revalidateConcurrency` also bounds the real remote work.
 */
function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error('Timed out.')));
    }, timeoutMs);
    void operation(controller.signal).then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
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
    for (const probe of sharedItemProbes(item)) {
      const key = sharedSpaceProbeKey(probe);
      const previous = unique.get(key);
      // Multiple history cards can share one direct conversation. Keep the
      // richer current viewer-Chat hint when one card has it; the probe key
      // intentionally stays owner+chat because both forms prove the same
      // authorization context.
      if (
        !previous ||
        (probe.kind === 'direct' &&
          Boolean(probe.viewerChatGrantId) &&
          (previous.kind !== 'direct' || !previous.viewerChatGrantId))
      ) {
        unique.set(key, probe);
      }
    }
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
      {
        eName: item.sourceSpaceKey,
        kind: 'direct',
        chatId: item.sourceChatId,
        ...(item.sourceViewerChatGrantId
          ? { viewerChatGrantId: item.sourceViewerChatGrantId }
          : {}),
      },
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

function sharedAccessIsFresh(cached: CachedSharedSpaceAccess, now: number, ttlMs: number): boolean {
  // A retry is intentionally short-lived so an intermittent remote eVault
  // failure can recover promptly. Positive/negative results are stable enough
  // for the catalogue cache; the media route always performs its own check.
  const maxAge =
    cached.value.access === 'retry' ? Math.min(ttlMs, sharedAccessRetryCacheTtlMs) : ttlMs;
  return now - cached.checkedAt < maxAge;
}

function hasStaleSharedAccess(entry: CacheEntry, checkedAt: number, ttlMs: number): boolean {
  return entry.spaces.some((space) => {
    const cached = entry.sharedAccess.get(sharedSpaceProbeKey(space));
    return !cached || !sharedAccessIsFresh(cached, checkedAt, ttlMs);
  });
}

function sharedItemNeedsRevalidation(
  item: MeshengerVideo,
  entry: CacheEntry,
  checkedAt: number,
  ttlMs: number,
): boolean {
  return sharedItemProbes(item).some((space) => {
    const cached = entry.sharedAccess.get(sharedSpaceProbeKey(space));
    return !cached || !sharedAccessIsFresh(cached, checkedAt, ttlMs);
  });
}

function pruneSharedAccess(entry: CacheEntry): void {
  const activeKeys = new Set(entry.spaces.map(sharedSpaceProbeKey));
  for (const key of entry.sharedAccess.keys()) {
    if (!activeKeys.has(key)) entry.sharedAccess.delete(key);
  }
}
