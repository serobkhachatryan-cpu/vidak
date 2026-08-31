vi.mock('server-only', () => ({}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshengerLibrary, MeshengerVideo } from '../meshenger-video-library';
import { completeInventory } from './completeness';
import type { InventorySourceCounts } from './discovery';
import { createInventoryCoordinator, publicLibraryItems } from './inventory-coordinator';
import { createMemoryInventoryJobStore, setInventoryJobStoreForTests } from './job-store';

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
  });

  afterEach(() => {
    vi.useRealTimers();
    setInventoryJobStoreForTests(undefined);
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

  it('drops cached shared items after access is revoked', async () => {
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
    const probeSharedSpaceAccess = vi
      .fn()
      .mockResolvedValueOnce({ access: 'ok', member: true })
      .mockResolvedValueOnce({ access: 'denied', member: false });
    const coordinator = createInventoryCoordinator({
      createScanner: () => ({ scanLibrary, probeSharedSpaceAccess }),
      log: () => undefined,
      ttlMs: 60_000,
    });
    const first = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).not.toHaveProperty('sourceSpaceKey');
    const again = await coordinator.getSnapshot({ eName: '@person.w3id' }, { scope: 'shared' });
    expect(again.metrics.cache).toBe('hit');
    expect(again.items).toEqual([]);
    expect(scanLibrary).toHaveBeenCalledTimes(1);
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
        accessBasis: 'personal',
      }),
    ]);
    expect(JSON.stringify(items)).not.toMatch(/@secret|cookie|Bearer|https:\/\//i);
    expect(items[0]).not.toHaveProperty('sourceSpaceKey');
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

  it('resumes an incomplete inventory instead of serving it as a TTL cache hit', async () => {
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
    expect(scanLibrary).toHaveBeenCalledTimes(2);
    expect(secondSnap.discovery).toBe('complete');
    expect(secondSnap.items.map((item) => item.title)).toEqual(
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
      async (_user: unknown, options: { drain?: boolean; onSnapshot: SnapshotHandler }) => {
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
    expect(afterPump.discovery).toBe('refreshing');
    expect(
      scanLibrary.mock.calls.some((call) => (call[1] as { drain?: boolean }).drain === true),
    ).toBe(true);
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
