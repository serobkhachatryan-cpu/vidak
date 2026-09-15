vi.mock('server-only', () => ({}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MeshengerLibrary,
  MeshengerVideo,
  SharedSpaceProbe,
} from '../meshenger-video-library';
import { setOperationalLogSinkForTests } from '../ops-observability';
import {
  reserveInteractivePlayback,
  resetBackgroundWorkPriorityForTests,
} from './background-work-priority';
import { VIDEO_SPACE_CATALOGUE_VERSION } from './catalogue-version';
import { completeInventory } from './completeness';
import type { InventorySourceCounts } from './discovery';
import { createInventoryCoordinator, publicLibraryItems } from './inventory-coordinator';
import { createMemoryInventoryJobStore, setInventoryJobStoreForTests } from './job-store';
import { resetSharedAccessCacheForTests } from './shared-access-cache';

type SnapshotHandler = (
  library: MeshengerLibrary,
  phase: 'batch' | 'done',
  counts: InventorySourceCounts,
) => void;

function video(
  partial: Partial<MeshengerVideo> & Pick<MeshengerVideo, 'id' | 'title'>,
): MeshengerVideo {
  return {
    kind: 'file',
    accessScope: 'personal',
    visibility: 'private',
    streamIds: ['opaque-stream'],
    ...partial,
  };
}

function library(items: MeshengerVideo[], completeness = completeInventory): MeshengerLibrary {
  return { items, conversations: [], messages: [], completeness };
}

describe('inventory coordinator', () => {
  beforeEach(() => {
    setInventoryJobStoreForTests(createMemoryInventoryJobStore());
    resetBackgroundWorkPriorityForTests();
    resetSharedAccessCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    setInventoryJobStoreForTests(undefined);
    setOperationalLogSinkForTests(undefined);
    resetBackgroundWorkPriorityForTests();
    resetSharedAccessCacheForTests();
  });

  it('returns an owner-scoped public persisted watch card without starting a source scan', async () => {
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    const job = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const shared = video({
      id: 'w3ds-file:@owner.w3id/shared-recording',
      title: 'Shared recording',
      kind: 'call-recording',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@owner.w3id',
      sourceChatId: 'private-chat-envelope',
      sourceViewerChatGrantId: 'viewer-grant',
      accessBasis: 'history',
      sharedBy: 'Untrusted source name',
    });
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: { ...job.completeness, complete: true, retryNeeded: false },
      ledger: { drainFinished: true, catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION },
      items: [shared],
    });
    const scanLibrary = vi.fn();
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    const item = await coordinator.getItem(
      { eName: '@viewer.w3id' },
      { itemId: shared.id, scope: 'all' },
    );

    expect(item).toMatchObject({
      id: shared.id,
      title: 'Shared recording',
      streamIds: ['opaque-stream'],
      sharedVia: 'conversation',
    });
    expect(item).not.toHaveProperty('sourceSpaceKey');
    expect(item).not.toHaveProperty('sourceChatId');
    expect(item).not.toHaveProperty('sourceViewerChatGrantId');
    expect(item).not.toHaveProperty('accessBasis');
    expect(item).not.toHaveProperty('sharedBy');
    expect(scanLibrary).not.toHaveBeenCalled();
  });

  it('hides only a confirmed-quarantined shared card from a library snapshot', async () => {
    const staleBindingHash = 'a'.repeat(43);
    const healthyBindingHash = 'b'.repeat(43);
    const stale = video({
      id: 'shared-stale',
      title: 'No longer shared',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sharedCardBindingHash: staleBindingHash,
    });
    const healthy = video({
      id: 'shared-healthy',
      title: 'Still shared',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sharedCardBindingHash: healthyBindingHash,
    });
    const personal = video({ id: 'personal-1', title: 'Mine' });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([stale, healthy, personal]), 'done', {
        personalPages: 1,
        sharedSpaces: 2,
        failed: 0,
      });
      return library([stale, healthy, personal]);
    });
    const matching = vi.fn(
      async (hashes: readonly string[]) =>
        new Set(hashes.includes(staleBindingHash) ? [staleBindingHash] : []),
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      sharedCardQuarantineStore: { matching },
      log: () => undefined,
    });

    const snapshot = await coordinator.getSnapshot({ eName: '@viewer.w3id' }, { scope: 'all' });

    expect(snapshot.items.map((item) => item.id)).toEqual(['shared-healthy', 'personal-1']);
    expect(JSON.stringify(snapshot.items)).not.toContain(staleBindingHash);
    expect(JSON.stringify(snapshot.items)).not.toContain(healthyBindingHash);
  });

  it('does not rescan or re-expose a quarantined in-memory exact card', async () => {
    const staleBindingHash = 'c'.repeat(43);
    const stale = video({
      id: 'shared-stale',
      title: 'No longer shared',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sharedCardBindingHash: staleBindingHash,
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([stale]), 'done', {
        personalPages: 0,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([stale]);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      sharedCardQuarantineStore: { matching: async () => new Set([staleBindingHash]) },
      log: () => undefined,
    });

    await coordinator.getSnapshot({ eName: '@viewer.w3id' }, { scope: 'all' });
    const item = await coordinator.getItem(
      { eName: '@viewer.w3id' },
      { itemId: stale.id, scope: 'all' },
    );

    expect(item).toBeUndefined();
    expect(scanLibrary).toHaveBeenCalledTimes(1);
  });

  it('clears a quarantine only after a fresh positive shared-source recheck', async () => {
    const bindingHash = 'e'.repeat(43);
    const shared = video({
      id: 'shared-restored',
      title: 'Restored share',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@owner.w3id',
      accessBasis: 'membership',
      sharedCardBindingHash: bindingHash,
    });
    let quarantined = true;
    const clear = vi.fn(async (hash: string) => {
      if (hash === bindingHash) quarantined = false;
      return true;
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary: async (_user, options) => {
          options.onSnapshot(library([shared]), 'done', {
            personalPages: 0,
            sharedSpaces: 1,
            failed: 0,
          });
          return library([shared]);
        },
        probeSharedSpaceAccess: vi.fn().mockResolvedValue({ access: 'ok', member: true }),
      }),
      sharedCardQuarantineStore: {
        matching: async (hashes) =>
          new Set(quarantined && hashes.includes(bindingHash) ? [bindingHash] : []),
        clear,
      },
      log: () => undefined,
    });

    await coordinator.getSnapshot({ eName: '@viewer.w3id' }, { scope: 'shared' });
    await vi.waitFor(() => expect(clear).toHaveBeenCalledWith(bindingHash));
    const restored = await coordinator.getSnapshot({ eName: '@viewer.w3id' }, { scope: 'shared' });
    expect(restored.items.map((item) => item.id)).toEqual([shared.id]);
  });

  it('does not fall back to a source scan for a quarantined persisted exact card', async () => {
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    const job = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const staleBindingHash = 'd'.repeat(43);
    const stale = video({
      id: 'shared-stale',
      title: 'No longer shared',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sharedCardBindingHash: staleBindingHash,
    });
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: { ...job.completeness, complete: true, retryNeeded: false },
      ledger: { drainFinished: true, catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION },
      items: [stale],
    });
    const scanLibrary = vi.fn();
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      sharedCardQuarantineStore: { matching: async () => new Set([staleBindingHash]) },
      log: () => undefined,
    });

    const item = await coordinator.getItem(
      { eName: '@viewer.w3id' },
      { itemId: stale.id, scope: 'all' },
    );

    expect(item).toBeUndefined();
    expect(scanLibrary).not.toHaveBeenCalled();
  });

  it('reuses a fresh in-memory exact card without another source scan', async () => {
    const target = video({ id: 'personal-target', title: 'Personal target' });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([target]), 'done', {
        personalPages: 1,
        sharedSpaces: 0,
        failed: 0,
      });
      return library([target]);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    await coordinator.getSnapshot({ eName: '@viewer.w3id' }, { scope: 'all' });
    const item = await coordinator.getItem(
      { eName: '@viewer.w3id' },
      { itemId: target.id, scope: 'all' },
    );

    expect(item).toMatchObject({ id: target.id, title: 'Personal target' });
    expect(scanLibrary).toHaveBeenCalledTimes(1);
  });

  it('falls back to the normal viewer-authorized snapshot after an exact durable miss', async () => {
    const target = video({ id: 'shared-target', title: 'Recovered shared target' });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([target]), 'done', {
        personalPages: 0,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([target]);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    const item = await coordinator.getItem(
      { eName: '@viewer.w3id' },
      { itemId: target.id, scope: 'all' },
    );

    expect(item).toMatchObject({ id: target.id, title: 'Recovered shared target' });
    expect(scanLibrary).toHaveBeenCalledTimes(1);
  });

  it('scopes owned and shared scans and coalesces in-flight work', async () => {
    const scans: string[] = [];
    let resolveOwned: (value: MeshengerLibrary) => void = () => undefined;
    const ownedFirst = video({ id: 'own-1', title: 'Mine' });
    const scanLibrary = vi.fn(
      async (_user: { eName: string }, options: { scope: string; onSnapshot: SnapshotHandler }) => {
        scans.push(options.scope);
        if (options.scope === 'owned') {
          options.onSnapshot(library([ownedFirst]), 'batch', {
            personalPages: 1,
            sharedSpaces: 0,
            failed: 0,
          });
          return new Promise<MeshengerLibrary>((resolve) => {
            resolveOwned = resolve;
          });
        }
        options.onSnapshot(library([]), 'done', { personalPages: 1, sharedSpaces: 0, failed: 0 });
        return library([]);
      },
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn(),
      }),
      log: () => undefined,
    });

    const first = coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'owned' });
    const second = coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'owned' });
    const [a, b] = await Promise.all([first, second]);
    expect(a.discovery).toBe('refreshing');
    expect(b.discovery).toBe('refreshing');
    expect(a.items[0]?.title).toBe('Mine');
    expect(a.metrics.cache).toBe('miss');
    expect(b.metrics.cache).toBe('coalesced');
    expect(scanLibrary).toHaveBeenCalledTimes(1);
    expect(scans).toEqual(['owned']);

    resolveOwned(library([ownedFirst]));
    await scanLibrary.mock.results[0]?.value;

    const shared = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(shared.scope).toBe('shared');
    expect(scanLibrary).toHaveBeenCalledTimes(2);
  });

  it('reuses one background scan on manual refresh and keeps visible items', async () => {
    const owned = video({ id: 'own-1', title: 'Mine' });
    let scans = 0;
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      scans += 1;
      options.onSnapshot(library([owned]), 'batch', {
        personalPages: 1,
        sharedSpaces: 0,
        failed: 0,
      });
      if (scans === 1) {
        options.onSnapshot(library([owned]), 'done', {
          personalPages: 1,
          sharedSpaces: 0,
          failed: 0,
        });
        return library([owned]);
      }
      return new Promise<MeshengerLibrary>(() => undefined);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn(),
      }),
      log: () => undefined,
    });
    const first = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'owned' });
    expect(first.discovery).toBe('complete');
    const refreshA = coordinator.getSnapshot(
      { eName: '@person.w3id' },
      { scope: 'owned', refresh: true },
    );
    const refreshB = coordinator.getSnapshot(
      { eName: '@person.w3id' },
      { scope: 'owned', refresh: true },
    );
    const [kept, coalesced] = await Promise.all([refreshA, refreshB]);
    expect(kept.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Mine' })]),
    );
    expect(kept.discovery).toBe('refreshing');
    expect(coalesced.metrics.cache).toBe('coalesced');
    expect(scanLibrary).toHaveBeenCalledTimes(2);
  });

  it('keeps a discovered shared item visible after a source recheck is denied', async () => {
    const sharedVideo = video({
      id: 'shared-1',
      title: 'Group cut',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@group.w3id',
      accessBasis: 'membership',
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([sharedVideo]), 'done', {
        personalPages: 1,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([sharedVideo]);
    });
    const probeSharedSpaceAccess = vi.fn().mockResolvedValue({ access: 'denied', member: false });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess }),
      log: () => undefined,
      ttlMs: 60_000,
    });
    const first = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(first.items).toEqual([
      expect.objectContaining({ id: 'shared-1', sourceAccess: 'checking' }),
    ]);
    expect(first.discovery).toBe('complete');
    await vi.waitFor(async () => {
      const afterRecheck = await coordinator.getSnapshot(
        { eName: '@person.w3id' },
        { scope: 'shared' },
      );
      expect(afterRecheck.items).toEqual([expect.objectContaining({ id: 'shared-1' })]);
    });
    expect(scanLibrary).toHaveBeenCalledTimes(1);
    expect(probeSharedSpaceAccess).toHaveBeenCalledTimes(1);
  });

  it('keeps a canonical shared File reference when its local viewer reference verifies', async () => {
    const sharedReference = video({
      id: 'shared-file-reference',
      title: 'Shared video',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@canonical-owner.w3id',
      sourceReferenceId: 'local-reference',
      sourceReferenceFileId: 'canonical-file',
      accessBasis: 'reference',
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([sharedReference]), 'done', {
        personalPages: 1,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([sharedReference]);
    });
    const probeSharedSpaceAccess = vi.fn().mockResolvedValue({ access: 'ok', member: true });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess }),
      log: () => undefined,
    });

    const snapshot = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });

    expect(snapshot.items.map((item) => item.title)).toEqual(['Shared video']);
    expect(probeSharedSpaceAccess).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      {
        eName: '@canonical-owner.w3id',
        kind: 'reference',
        referenceId: 'local-reference',
        fileId: 'canonical-file',
      },
      'fail-fast',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('reuses a verified shared-source check between catalogue progress polls', async () => {
    let currentTime = 1_000;
    const sharedVideo = video({
      id: 'shared-1',
      title: 'Shared clip',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@group.w3id',
      accessBasis: 'membership',
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([sharedVideo]), 'done', {
        personalPages: 0,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([sharedVideo]);
    });
    const probeSharedSpaceAccess = vi.fn().mockResolvedValue({ access: 'ok', member: true });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess }),
      now: () => currentTime,
      sharedAccessCacheTtlMs: 30_000,
      log: () => undefined,
    });

    await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    await vi.waitFor(() => expect(probeSharedSpaceAccess).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const settled = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
      expect(settled.items[0]?.sourceAccess).toBeUndefined();
    });
    await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(probeSharedSpaceAccess).toHaveBeenCalledTimes(1);

    // The cross-route positive authorization cache is intentionally one
    // minute, so a media player's Range requests do not repeatedly re-probe.
    currentTime += 60_001;
    await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    await vi.waitFor(() => expect(probeSharedSpaceAccess).toHaveBeenCalledTimes(2));
  });

  it('keeps a retryable shared source visible but disabled without rescanning the library', async () => {
    const operationalLogs: string[] = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    const ownedVideo = video({ id: 'own-1', title: 'Personal clip' });
    const sharedVideo = video({
      id: 'shared-1',
      title: 'Shared clip',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@group.w3id',
      accessBasis: 'membership',
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([ownedVideo, sharedVideo]), 'done', {
        personalPages: 1,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([ownedVideo, sharedVideo]);
    });
    const probeSharedSpaceAccess = vi
      .fn()
      .mockRejectedValue(new Error('private eVault transport detail'));
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess }),
      log: () => undefined,
      ttlMs: 60_000,
    });

    const first = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    expect(first.items.map((item) => item.title)).toEqual(['Personal clip', 'Shared clip']);
    expect(first.items.find((item) => item.id === 'shared-1')).toMatchObject({
      sourceAccess: 'checking',
      streamIds: ['opaque-stream'],
    });
    expect(first.discovery).toBe('complete');

    let afterProbeFailure: Awaited<ReturnType<typeof coordinator.getSnapshot>> | undefined;
    await vi.waitFor(async () => {
      afterProbeFailure = await coordinator.getSnapshot(
        { eName: '@person.w3id' },
        { scope: 'all' },
      );
      expect(afterProbeFailure.discovery).toBe('refreshing');
    });
    const retrySnapshot = afterProbeFailure as Awaited<ReturnType<typeof coordinator.getSnapshot>>;
    expect(retrySnapshot.items.map((item) => item.title)).toEqual(['Personal clip', 'Shared clip']);
    expect(retrySnapshot.metrics.cache).toBe('hit');
    expect(retrySnapshot.completeness).toMatchObject({
      complete: false,
      retryNeeded: true,
      deferred: 1,
    });
    expect(JSON.stringify(retrySnapshot)).not.toContain('@group.w3id');
    expect(scanLibrary).toHaveBeenCalledTimes(1);
    expect(probeSharedSpaceAccess).toHaveBeenCalledTimes(1);
    expect(operationalLogs).toHaveLength(1);
    const operationalLog = operationalLogs[0] ?? '';
    expect(JSON.parse(operationalLog)).toMatchObject({
      level: 'info',
      category: 'video_library',
      code: 'shared_source_recheck_deferred',
    });
    expect(operationalLog).not.toContain('@group.w3id');
    expect(operationalLog).not.toContain('private eVault transport detail');
  });

  it('bounds a cached shared-access check so a stalled source cannot hang the library', async () => {
    const ownedVideo = video({ id: 'own-1', title: 'Personal clip' });
    const sharedVideo = video({
      id: 'shared-1',
      title: 'Shared clip',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@group.w3id',
      accessBasis: 'membership',
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([ownedVideo, sharedVideo]), 'done', {
        personalPages: 1,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([ownedVideo, sharedVideo]);
    });
    let aborted = false;
    const probeSharedSpaceAccess = vi.fn(
      (
        _user: { eName: string },
        _space: SharedSpaceProbe,
        _rateLimit?: 'fail-fast' | 'backoff',
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<{ access: 'retry'; member: false }>((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve({ access: 'retry', member: false });
            },
            { once: true },
          );
        }),
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess }),
      log: () => undefined,
      ttlMs: 60_000,
      revalidationTimeoutMs: 25,
    });

    const first = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    expect(first.items.map((item) => item.title)).toEqual(['Personal clip', 'Shared clip']);
    expect(probeSharedSpaceAccess).toHaveBeenCalledTimes(1);
    expect(probeSharedSpaceAccess).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      expect.objectContaining({ kind: 'group' }),
      'fail-fast',
      expect.objectContaining({ signal: expect.anything() }),
    );

    await vi.waitFor(() => expect(aborted).toBe(true));

    await vi.waitFor(async () => {
      const afterTimeout = await coordinator.getSnapshot(
        { eName: '@person.w3id' },
        { scope: 'all' },
      );
      expect(afterTimeout.items.map((item) => item.title)).toEqual([
        'Personal clip',
        'Shared clip',
      ]);
      expect(afterTimeout.discovery).toBe('refreshing');
    });
  });

  it('preempts a live background source recheck when playback begins without hiding its card', async () => {
    const sharedVideo = video({
      id: 'shared-1',
      title: 'Shared clip',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@group.w3id',
      accessBasis: 'membership',
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([sharedVideo]), 'done', {
        personalPages: 0,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([sharedVideo]);
    });
    let aborted = false;
    const probeSharedSpaceAccess = vi.fn(
      (
        _user: { eName: string },
        _space: SharedSpaceProbe,
        _rateLimit?: 'fail-fast' | 'backoff',
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<{ access: 'retry'; member: false }>((resolve) => {
          const abort = () => {
            aborted = true;
            resolve({ access: 'retry', member: false });
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        }),
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess }),
      log: () => undefined,
      ttlMs: 60_000,
      revalidationTimeoutMs: 60_000,
    });

    const first = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(first.items).toEqual([
      expect.objectContaining({ id: 'shared-1', sourceAccess: 'checking' }),
    ]);
    await vi.waitFor(() => expect(probeSharedSpaceAccess).toHaveBeenCalledTimes(1));

    reserveInteractivePlayback(30_000);
    await vi.waitFor(() => expect(aborted).toBe(true));

    await vi.waitFor(async () => {
      const afterPreemption = await coordinator.getSnapshot(
        { eName: '@person.w3id' },
        { scope: 'shared' },
      );
      expect(afterPreemption.items).toEqual([
        expect.objectContaining({ id: 'shared-1', title: 'Shared clip', sourceAccess: 'checking' }),
      ]);
    });
  });

  it('checks the exact conversation and its authorized group fallback before showing history-shared media', async () => {
    const historyShared = video({
      id: 'shared-history-1',
      title: 'History-shared clip',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@group.w3id',
      sourceChatId: 'chat-1',
      sourceViewerChatGrantId: 'viewer-chat-grant',
      accessBasis: 'history',
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([historyShared]), 'done', {
        personalPages: 0,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([historyShared]);
    });
    const probeSharedSpaceAccess = vi.fn((_user: unknown, space: SharedSpaceProbe) =>
      Promise.resolve(
        space.kind === 'group'
          ? { access: 'ok' as const, member: true }
          : { access: 'missing' as const, member: false },
      ),
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess }),
      log: () => undefined,
    });

    const snapshot = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });

    expect(snapshot.items.map((item) => item.title)).toEqual(['History-shared clip']);
    expect(probeSharedSpaceAccess).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      expect.objectContaining({
        kind: 'direct',
        chatId: 'chat-1',
        viewerChatGrantId: 'viewer-chat-grant',
      }),
      'fail-fast',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(probeSharedSpaceAccess).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      expect.objectContaining({ kind: 'group' }),
      'fail-fast',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('returns 429 work as partial without pretending it is complete', async () => {
    const owned = video({ id: 'own-1', title: 'Mine' });
    const incomplete = {
      indexed: 0,
      expected: 1,
      denied: 0,
      missing: 0,
      complete: false,
      retryNeeded: true,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 1,
    };
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([owned], incomplete), 'batch', {
        personalPages: 1,
        sharedSpaces: 1,
        failed: 1,
      });
      options.onSnapshot(library([owned], incomplete), 'done', {
        personalPages: 1,
        sharedSpaces: 1,
        failed: 1,
      });
      return library([owned], incomplete);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn(),
      }),
      log: () => undefined,
    });
    const snapshot = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.discovery).toBe('partial');
    expect(snapshot.completeness.retryRateLimited).toBe(1);
    expect(snapshot.discovery).not.toBe('complete');
  });

  it('updates the cached snapshot after every batch including a 429 retry', async () => {
    const first = video({ id: 'shared-1', title: 'First clip', accessScope: 'shared' });
    const second = video({ id: 'shared-2', title: 'Later clip', accessScope: 'shared' });
    const refreshing = {
      indexed: 1,
      expected: 2,
      denied: 0,
      missing: 0,
      complete: false,
      retryNeeded: false,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
      retrying: 1,
    };
    const complete = {
      ...completeInventory,
      indexed: 2,
      expected: 2,
    };
    let emit: SnapshotHandler | undefined;
    let resolveScan: (value: MeshengerLibrary) => void = () => undefined;
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      emit = options.onSnapshot;
      options.onSnapshot(library([first], refreshing), 'batch', {
        personalPages: 1,
        sharedSpaces: 1,
        failed: 0,
      });
      return new Promise<MeshengerLibrary>((resolve) => {
        resolveScan = resolve;
      });
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn(),
      }),
      log: () => undefined,
    });
    const initial = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(initial.discovery).toBe('refreshing');
    expect(initial.items.map((item) => item.title)).toEqual(['First clip']);

    emit?.(library([first, second], refreshing), 'batch', {
      personalPages: 1,
      sharedSpaces: 2,
      failed: 0,
    });
    const grown = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(grown.discovery).toBe('refreshing');
    expect(grown.items.map((item) => item.title)).toEqual(
      expect.arrayContaining(['First clip', 'Later clip']),
    );

    emit?.(library([first, second], complete), 'done', {
      personalPages: 1,
      sharedSpaces: 2,
      failed: 0,
    });
    resolveScan(library([first, second], complete));
    await scanLibrary.mock.results[0]?.value;
    const finished = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(finished.discovery).toBe('complete');
    expect(finished.items).toHaveLength(2);
  });

  it('keeps earlier batches when a later source is still retrying', async () => {
    const kept = video({ id: 'owned-1', title: 'Kept' });
    const later = video({ id: 'owned-2', title: 'Added later' });
    let emit: SnapshotHandler | undefined;
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      emit = options.onSnapshot;
      options.onSnapshot(library([kept]), 'batch', {
        personalPages: 1,
        sharedSpaces: 0,
        failed: 0,
      });
      return new Promise<MeshengerLibrary>(() => undefined);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn(),
      }),
      log: () => undefined,
    });
    await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'owned' });
    emit?.(library([later]), 'batch', { personalPages: 2, sharedSpaces: 0, failed: 0 });
    const merged = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'owned' });
    expect(merged.items.map((item) => item.title)).toEqual(
      expect.arrayContaining(['Kept', 'Added later']),
    );
  });

  it('never copies tokens, cookies, or media URLs into the public catalogue', () => {
    const items = publicLibraryItems([
      video({
        id: 'own-1',
        title: 'Mine',
        sourceSpaceKey: '@secret.w3id',
        sourceViewerChatGrantId: 'private-viewer-chat-grant',
        sourceReferenceId: 'private-reference',
        sourceReferenceFileId: 'private-file',
        accessBasis: 'personal',
      }),
    ]);
    expect(JSON.stringify(items)).not.toMatch(/@secret|cookie|Bearer|https:\/\//i);
    expect(items[0]).not.toHaveProperty('sourceSpaceKey');
    expect(items[0]).not.toHaveProperty('sourceViewerChatGrantId');
    expect(items[0]).not.toHaveProperty('sourceReferenceId');
    expect(items[0]).not.toHaveProperty('sourceReferenceFileId');
  });

  it('adds safe shared-source context without exposing the source identity', () => {
    const items = publicLibraryItems([
      video({
        id: 'shared-1',
        title: 'Shared',
        accessScope: 'shared',
        visibility: 'shared-with-me',
        sourceSpaceKey: '@friend.w3id',
        sourceChatId: 'private-chat-123',
        accessBasis: 'membership',
      }),
    ]);
    expect(items[0]).toMatchObject({ sharedVia: 'group' });
    expect(JSON.stringify(items)).not.toContain('@friend.w3id');
    expect(JSON.stringify(items)).not.toContain('private-chat-123');
  });

  it('attributes an authorized direct share using only its chosen public name', async () => {
    const sharedVideo = video({
      id: 'shared-1',
      title: 'Shared',
      accessScope: 'shared',
      visibility: 'shared-with-me',
      sourceSpaceKey: '@friend.w3id',
      sourceChatId: 'private-chat-123',
      accessBasis: 'history',
    });
    const resolveSharedSourceNames = vi.fn(async () => new Map([['@friend.w3id', 'Ada Lovelace']]));
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary: async (_user, options) => {
          options.onSnapshot(library([sharedVideo]), 'done', {
            personalPages: 0,
            sharedSpaces: 1,
            failed: 0,
          });
          return library([sharedVideo]);
        },
        probeSharedSpaceAccess: vi.fn().mockResolvedValue({ access: 'ok', member: true }),
      }),
      resolveSharedSourceNames,
      log: () => undefined,
    });

    await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    await vi.waitFor(async () => {
      const snapshot = await coordinator.getSnapshot(
        { eName: '@person.w3id' },
        { scope: 'shared' },
      );
      expect(snapshot.items).toEqual([
        expect.objectContaining({ sharedVia: 'conversation', sharedBy: 'Ada Lovelace' }),
      ]);
      expect(JSON.stringify(snapshot.items)).not.toContain('@friend.w3id');
      expect(JSON.stringify(snapshot.items)).not.toContain('private-chat-123');
    });
    expect(resolveSharedSourceNames).toHaveBeenCalledWith(['@friend.w3id']);
  });

  it('inventories owned messenger/call videos plus authorized shared videos without duplicates', async () => {
    const ownedCall = video({
      id: 'call-1',
      title: 'Call recording · 2026-08-24',
      kind: 'call-recording',
      accessScope: 'personal',
    });
    const sharedClip = video({
      id: 'shared-1',
      title: 'Friend briefing',
      accessScope: 'shared',
      visibility: 'shared-with-me',
    });
    const scanLibrary = vi.fn(
      async (_user: unknown, options: { scope: string; onSnapshot: SnapshotHandler }) => {
        expect(options.scope).toBe('all');
        options.onSnapshot(library([ownedCall]), 'batch', {
          personalPages: 2,
          sharedSpaces: 0,
          failed: 0,
        });
        options.onSnapshot(
          library([ownedCall, sharedClip, { ...ownedCall, id: 'call-1' }]),
          'done',
          {
            personalPages: 2,
            sharedSpaces: 1,
            failed: 0,
          },
        );
        return library([ownedCall, sharedClip]);
      },
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn().mockResolvedValue({ access: 'ok', member: true }),
      }),
      log: () => undefined,
    });
    const snapshot = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    expect(snapshot.scope).toBe('all');
    expect(snapshot.items.map((item) => item.title).sort()).toEqual([
      'Call recording · 2026-08-24',
      'Friend briefing',
    ]);
    expect(
      snapshot.items.filter((item) => item.title === 'Call recording · 2026-08-24'),
    ).toHaveLength(1);
    expect(scanLibrary).toHaveBeenCalledTimes(1);
  });

  it('keeps an incomplete inventory warm until the user explicitly refreshes it', async () => {
    const first = video({ id: 'shared-1', title: 'First clip', accessScope: 'shared' });
    const second = video({ id: 'shared-2', title: 'Later clip', accessScope: 'shared' });
    const incomplete = {
      indexed: 3,
      expected: 7,
      denied: 0,
      missing: 0,
      failed: 0,
      complete: false,
      retryNeeded: true,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 4,
      retrying: 0,
    };
    const complete = {
      ...completeInventory,
      indexed: 7,
      expected: 7,
    };
    let scans = 0;
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      scans += 1;
      if (scans === 1) {
        options.onSnapshot(library([first], incomplete), 'done', {
          personalPages: 1,
          sharedSpaces: 3,
          failed: 0,
        });
        return library([first], incomplete);
      }
      options.onSnapshot(library([first, second], complete), 'done', {
        personalPages: 1,
        sharedSpaces: 7,
        failed: 0,
      });
      return library([first, second], complete);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn().mockResolvedValue({ access: 'ok', member: true }),
      }),
      log: () => undefined,
      ttlMs: 60_000,
    });
    const firstSnap = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(firstSnap.discovery).toBe('partial');
    expect(firstSnap.items).toHaveLength(1);
    const secondSnap = await coordinator.getSnapshot(
      { eName: '@person.w3id' },
      { scope: 'shared' },
    );
    expect(scanLibrary).toHaveBeenCalledTimes(1);
    expect(secondSnap.discovery).toBe('partial');
    expect(secondSnap.items.map((item) => item.title)).toEqual(['First clip']);

    const refreshed = await coordinator.getSnapshot(
      { eName: '@person.w3id' },
      { scope: 'shared', refresh: true },
    );
    expect(scanLibrary).toHaveBeenCalledTimes(2);
    expect(refreshed.discovery).toBe('complete');
    expect(refreshed.items.map((item) => item.title)).toEqual(
      expect.arrayContaining(['First clip', 'Later clip']),
    );
  });

  it('hydrates over HTTP without draining and lets the pump continue after polls stop', async () => {
    const clip = video({ id: 'shared-1', title: 'Later clip', accessScope: 'shared' });
    const refreshing = {
      indexed: 0,
      expected: 1,
      denied: 0,
      missing: 0,
      complete: false,
      retryNeeded: false,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
      retrying: 0,
    };
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    const scanLibrary = vi.fn(
      async (
        _user: unknown,
        options: {
          drain?: boolean;
          maxWaves?: number;
          maxVaultsPerWave?: number;
          onSnapshot: SnapshotHandler;
        },
      ) => {
        if (options.drain === true) {
          options.onSnapshot(library([clip], refreshing), 'batch', {
            personalPages: 2,
            sharedSpaces: 1,
            failed: 0,
          });
          return library([clip], refreshing);
        }
        options.onSnapshot(library([], refreshing), 'batch', {
          personalPages: 0,
          sharedSpaces: 0,
          failed: 0,
        });
        return library([], refreshing);
      },
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn(),
      }),
      log: () => undefined,
    });
    const first = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    expect(first.discovery).toBe('refreshing');
    expect(first.items).toEqual([]);
    expect(
      scanLibrary.mock.calls.every((call) => (call[1] as { drain?: boolean }).drain !== true),
    ).toBe(true);

    await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await coordinator.pumpRunning();
    const afterPump = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    expect(afterPump.items.map((item) => item.title)).toEqual(['Later clip']);
    // The queue is still durable and running, so the client keeps its
    // low-frequency progress poll instead of freezing on the first batch.
    expect(afterPump.discovery).toBe('refreshing');
    expect(
      scanLibrary.mock.calls.some((call) => (call[1] as { drain?: boolean }).drain === true),
    ).toBe(true);
    expect(
      scanLibrary.mock.calls.some(
        (call) =>
          (call[1] as { drain?: boolean; maxWaves?: number }).drain === true &&
          (call[1] as { maxWaves?: number }).maxWaves === 1,
      ),
    ).toBe(true);
    expect(
      scanLibrary.mock.calls.some(
        (call) => (call[1] as { maxVaultsPerWave?: number }).maxVaultsPerWave === 1,
      ),
    ).toBe(true);
  });

  it('does not let repeated catalogue polls trigger a durable eVault drain', async () => {
    const refreshing = { ...completeInventory, complete: false, retrying: 1 };
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const scanLibrary = vi.fn(
      async (_user: unknown, options: { drain?: boolean; onSnapshot: SnapshotHandler }) => {
        options.onSnapshot(library([], refreshing), 'batch', {
          personalPages: 0,
          sharedSpaces: 0,
          failed: 0,
        });
        return library([], refreshing);
      },
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    // Give any accidentally fire-and-forget work a turn. An HTTP poll only
    // serves its snapshot; the process-level scheduler owns remote drains.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(
      scanLibrary.mock.calls.every((call) => (call[1] as { drain?: boolean }).drain !== true),
    ).toBe(true);

    await coordinator.pumpRunning();
    expect(
      scanLibrary.mock.calls.some((call) => (call[1] as { drain?: boolean }).drain === true),
    ).toBe(true);
  });

  it('runs only one durable owner job per pump wave so catalogue catch-up cannot flood eVaults', async () => {
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    await store.createJob({
      ownerEName: '@first.w3id',
      ownerEVaultUri: 'https://first-vault.example',
    });
    await store.createJob({
      ownerEName: '@second.w3id',
      ownerEVaultUri: 'https://second-vault.example',
    });
    const refreshing = { ...completeInventory, complete: false, retrying: 1 };
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([], refreshing), 'batch', {
        personalPages: 0,
        sharedSpaces: 0,
        failed: 0,
      });
      return library([], refreshing);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    await coordinator.pumpRunning();

    expect(scanLibrary).toHaveBeenCalledTimes(1);
    expect(scanLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ eName: expect.stringMatching(/^@(first|second)\.w3id$/) }),
      expect.objectContaining({ drain: true, maxWaves: 1, maxVaultsPerWave: 1 }),
    );
  });

  it('uses one preemptible pump wave for queued shared recording warmups', async () => {
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    const job = await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      ledger: {
        ...job.ledger,
        queue: [
          {
            type: 'prewarm-call-media',
            attempts: 0,
            vaultKey: '@media.w3id',
            fileUri: 'w3ds://file?id=@media.w3id/recording-part-1',
            recordKey: 'call:@group.w3id/recording-1',
            streamGrant: {},
          },
        ],
      },
    });
    const scanLibrary = vi.fn().mockResolvedValue(library([]));
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    await coordinator.pumpRunning();

    expect(scanLibrary).toHaveBeenCalledWith(
      { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
      expect.objectContaining({ drain: true, maxWaves: 1, maxVaultsPerWave: 1 }),
    );
  });

  it('keeps progress polling active when the foreground checkpoint leaves durable work', async () => {
    const refreshing = {
      indexed: 1,
      expected: 3,
      denied: 0,
      missing: 0,
      failed: 0,
      complete: false,
      retryNeeded: false,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
      retrying: 0,
    };
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const scanLibrary = vi.fn(async (_user: unknown, options: { onSnapshot: SnapshotHandler }) => {
      options.onSnapshot(library([], refreshing), 'batch', {
        personalPages: 0,
        sharedSpaces: 1,
        failed: 0,
      });
      return library([], refreshing);
    });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    const snapshot = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });

    expect(snapshot.discovery).toBe('refreshing');
    expect(scanLibrary).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      expect.objectContaining({ drain: false }),
    );
  });

  it('reports a pump outage once without including private failure details', async () => {
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const logs: string[] = [];
    const operationalLogs: string[] = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary: vi
          .fn()
          .mockRejectedValue(new Error('private source details must not be logged')),
        probeSharedSpaceAccess: vi.fn(),
      }),
      log: (line) => logs.push(line),
    });

    await coordinator.pumpRunning();
    await coordinator.pumpRunning();

    expect(logs).toEqual(['[inventory-pump] failed']);
    expect(operationalLogs).toEqual([expect.stringContaining('"category":"video_library"')]);
    expect(operationalLogs[0]).toContain('"code":"background_pump_failed"');
    expect(operationalLogs[0]).not.toContain('private source details');
    expect(operationalLogs[0]).not.toContain('@person.w3id');
  });

  it('coalesces overlapping durable pump requests instead of queuing inventory waves', async () => {
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseScan: (value: MeshengerLibrary) => void = () => undefined;
    const refreshing = {
      ...completeInventory,
      complete: false,
      retrying: 1,
    };
    const scanLibrary = vi.fn(
      () =>
        new Promise<MeshengerLibrary>((resolve) => {
          notifyStarted();
          releaseScan = resolve;
        }),
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    const first = coordinator.pumpRunning();
    await started;
    const second = coordinator.pumpRunning();
    const third = coordinator.pumpRunning();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(scanLibrary).toHaveBeenCalledTimes(1);

    releaseScan(library([], refreshing));
    await first;
    // The second run intentionally remains pending: its only purpose is to
    // prove that a later timer tick starts one fresh wave rather than a queue
    // of every overlapping tick that arrived while the first scan was open.
    void coordinator.pumpRunning();
    await vi.waitFor(() => expect(scanLibrary).toHaveBeenCalledTimes(2));
  });

  it('postpones a new durable inventory wave while playback has priority', async () => {
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const scanLibrary = vi.fn().mockResolvedValue(library([]));
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    reserveInteractivePlayback(30_000);
    await coordinator.pumpRunning();

    expect(scanLibrary).not.toHaveBeenCalled();

    resetBackgroundWorkPriorityForTests();
    await coordinator.pumpRunning();
    expect(scanLibrary).toHaveBeenCalledTimes(1);
  });

  it('preempts an active durable job with a resumable background lease', async () => {
    const store = createMemoryInventoryJobStore();
    setInventoryJobStoreForTests(store);
    await store.createJob({
      ownerEName: '@person.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    let signal: AbortSignal | undefined;
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const refreshing = { ...completeInventory, complete: false };
    let scans = 0;
    const scanLibrary = vi.fn(
      async (_user: unknown, options: { signal?: AbortSignal; onSnapshot: SnapshotHandler }) => {
        scans += 1;
        if (scans > 1) return library([], refreshing);
        signal = options.signal;
        notifyStarted();
        return new Promise<MeshengerLibrary>((resolve) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              options.onSnapshot(library([], refreshing), 'batch', {
                personalPages: 0,
                sharedSpaces: 0,
                failed: 0,
              });
              resolve(library([], refreshing));
            },
            { once: true },
          );
        });
      },
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    const first = coordinator.pumpRunning();
    await started;
    expect(signal).toBeDefined();

    reserveInteractivePlayback(30_000);
    await first;

    expect(signal?.aborted).toBe(true);
    expect(scanLibrary).toHaveBeenCalledWith(
      { eName: '@person.w3id', eVaultUri: 'https://vault.example' },
      expect.objectContaining({ drain: true, signal: expect.anything() }),
    );

    resetBackgroundWorkPriorityForTests();
    await coordinator.pumpRunning();
    expect(scanLibrary).toHaveBeenCalledTimes(2);
  });

  it('preempts a cache-miss checkpoint when playback begins and retries it later', async () => {
    let signal: AbortSignal | undefined;
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const refreshing = { ...completeInventory, complete: false };
    let scans = 0;
    const scanLibrary = vi.fn(
      async (_user: unknown, options: { signal?: AbortSignal; onSnapshot: SnapshotHandler }) => {
        scans += 1;
        if (scans > 1) {
          options.onSnapshot(library([], completeInventory), 'done', {
            personalPages: 0,
            sharedSpaces: 0,
            failed: 0,
          });
          return library([], completeInventory);
        }
        signal = options.signal;
        notifyStarted();
        return new Promise<MeshengerLibrary>((resolve) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              options.onSnapshot(library([], refreshing), 'batch', {
                personalPages: 0,
                sharedSpaces: 0,
                failed: 0,
              });
              resolve(library([], refreshing));
            },
            { once: true },
          );
        });
      },
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess: vi.fn() }),
      log: () => undefined,
    });

    const first = coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    await started;
    expect(signal).toBeDefined();

    reserveInteractivePlayback(30_000);
    await first;
    expect(signal?.aborted).toBe(true);
    expect(scanLibrary).toHaveBeenCalledWith(
      { eName: '@person.w3id' },
      expect.objectContaining({ drain: false, signal: expect.anything() }),
    );

    resetBackgroundWorkPriorityForTests();
    await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(scanLibrary).toHaveBeenCalledTimes(2);
  });

  it('does not start a second drain when two polls overlap', async () => {
    const refreshing = {
      indexed: 0,
      expected: 1,
      denied: 0,
      missing: 0,
      complete: false,
      retryNeeded: false,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
      retrying: 1,
    };
    const scanLibrary = vi.fn(
      async (_user: unknown, options: { drain?: boolean; onSnapshot: SnapshotHandler }) => {
        expect(options.drain).not.toBe(true);
        options.onSnapshot(library([], refreshing), 'batch', {
          personalPages: 0,
          sharedSpaces: 0,
          failed: 0,
        });
        return library([], refreshing);
      },
    );
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({
        scanLibrary,
        probeSharedSpaceAccess: vi.fn(),
      }),
      log: () => undefined,
    });
    const first = coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    const second = coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'all' });
    await Promise.all([first, second]);
    expect(
      scanLibrary.mock.calls.every((call) => (call[1] as { drain?: boolean }).drain !== true),
    ).toBe(true);
    expect(scanLibrary).toHaveBeenCalledTimes(1);
  });
});
