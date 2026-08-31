vi.mock('server-only', () => ({}));

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshengerLibrary, MeshengerVideo } from '../meshenger-video-library';
import { completeInventory } from './completeness';
import type { InventorySourceCounts } from './discovery';
import { createInventoryCoordinator, publicLibraryItems } from './inventory-coordinator';

type SnapshotHandler = (
  library: MeshengerLibrary,
  phase: 'first' | 'done',
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scopes owned and shared scans and coalesces in-flight work', async () => {
    const scans: string[] = [];
    let resolveOwned: (value: MeshengerLibrary) => void = () => undefined;
    const ownedFirst = video({ id: 'own-1', title: 'Mine' });
    const scanLibrary = vi.fn(
      async (_user: { eName: string }, options: { scope: string; onSnapshot: SnapshotHandler }) => {
        scans.push(options.scope);
        if (options.scope === 'owned') {
          options.onSnapshot(library([ownedFirst]), 'first', {
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
      options.onSnapshot(library([owned]), 'first', {
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
      options.onSnapshot(library([owned], incomplete), 'first', {
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
});
