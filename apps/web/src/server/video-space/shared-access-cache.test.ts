import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { coalesceSharedAccessProbe, resetSharedAccessCacheForTests } from './shared-access-cache';

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
});
