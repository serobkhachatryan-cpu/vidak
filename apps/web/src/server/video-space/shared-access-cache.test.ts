import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  coalesceSharedAccessProbe,
  hasVerifiedSharedAccess,
  invalidateVerifiedSharedAccess,
  resetSharedAccessCacheForTests,
} from './shared-access-cache';

const viewer = '@viewer.w3id';
const source = { eName: '@group.w3id', kind: 'group' as const };

describe('shared access cache', () => {
  afterEach(() => {
    resetSharedAccessCacheForTests();
  });

  it('does not make interactive playback wait behind a cancellable background probe', async () => {
    let releaseBackground: ((value: { access: 'retry'; member: false }) => void) | undefined;
    const backgroundProbe = vi.fn(
      () =>
        new Promise<{ access: 'retry'; member: false }>((resolve) => {
          releaseBackground = resolve;
        }),
    );
    const background = coalesceSharedAccessProbe(
      viewer,
      source,
      backgroundProbe,
      1_000,
      () => 1_000,
      { priority: 'background' },
    );
    const interactiveProbe = vi.fn().mockResolvedValue({ access: 'ok' as const, member: true });

    await expect(
      coalesceSharedAccessProbe(viewer, source, interactiveProbe, 1_000, () => 1_000, {
        priority: 'interactive',
      }),
    ).resolves.toEqual({ access: 'ok', member: true });
    expect(interactiveProbe).toHaveBeenCalledTimes(1);

    // A completed positive check is still reusable across priorities; only
    // pending work is isolated so background cancellation cannot delay Watch.
    const cachedBackgroundProbe = vi.fn();
    await expect(
      coalesceSharedAccessProbe(viewer, source, cachedBackgroundProbe, 1_001, () => 1_001, {
        priority: 'background',
      }),
    ).resolves.toEqual({ access: 'ok', member: true });
    expect(cachedBackgroundProbe).not.toHaveBeenCalled();

    releaseBackground?.({ access: 'retry', member: false });
    await expect(background).resolves.toEqual({ access: 'retry', member: false });
  });

  it('does not let a pre-invalidation positive probe reauthorize a refreshed source', async () => {
    let releaseOldProbe: ((value: { access: 'ok'; member: true }) => void) | undefined;
    const oldProbe = vi.fn(
      () =>
        new Promise<{ access: 'ok'; member: true }>((resolve) => {
          releaseOldProbe = resolve;
        }),
    );
    const oldPending = coalesceSharedAccessProbe(viewer, source, oldProbe, 1_000, () => 1_000, {
      priority: 'interactive',
    });

    invalidateVerifiedSharedAccess(viewer, source);
    let releaseFreshProbe: ((value: { access: 'ok'; member: true }) => void) | undefined;
    const freshProbe = vi.fn(
      () =>
        new Promise<{ access: 'ok'; member: true }>((resolve) => {
          releaseFreshProbe = resolve;
        }),
    );
    const freshPending = coalesceSharedAccessProbe(viewer, source, freshProbe, 1_001, () => 1_001, {
      priority: 'interactive',
    });
    expect(freshProbe).toHaveBeenCalledTimes(1);

    releaseOldProbe?.({ access: 'ok', member: true });
    await expect(oldPending).resolves.toEqual({ access: 'ok', member: true });
    // The old request may observe its original success, but it cannot make a
    // now-invalid proof usable by a later shared-source authorization.
    expect(hasVerifiedSharedAccess(viewer, source, 1_002)).toBe(false);
    releaseFreshProbe?.({ access: 'ok', member: true });
    await expect(freshPending).resolves.toEqual({ access: 'ok', member: true });
    expect(hasVerifiedSharedAccess(viewer, source, 1_003)).toBe(true);
  });

  it('can require a fresh proof without losing single-flight protection', async () => {
    const initialProbe = vi.fn().mockResolvedValue({ access: 'ok' as const, member: true });
    await coalesceSharedAccessProbe(viewer, source, initialProbe, 1_000, () => 1_000, {
      priority: 'interactive',
    });

    const freshProbe = vi.fn().mockResolvedValue({ access: 'ok' as const, member: true });
    await expect(
      coalesceSharedAccessProbe(viewer, source, freshProbe, 1_001, () => 1_001, {
        priority: 'interactive',
        bypassVerifiedAccess: true,
      }),
    ).resolves.toEqual({ access: 'ok', member: true });

    expect(freshProbe).toHaveBeenCalledTimes(1);
  });
});
