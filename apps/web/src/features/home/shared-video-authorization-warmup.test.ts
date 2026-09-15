import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelCancellableSharedVideoAuthorizationHoverWork,
  resetSharedVideoAuthorizationWarmupsForTests,
  scheduleSharedVideoAuthorizationWarmup,
  warmSharedVideoAuthorization,
} from './shared-video-authorization-warmup';

afterEach(() => {
  resetSharedVideoAuthorizationWarmupsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shared video authorization warmup', () => {
  it('limits simultaneous explicit watch warmups', async () => {
    const deferred = new Map<string, () => void>();
    const fetcher = vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          deferred.set(url, () => resolve(new Response(null, { status: 204 })));
        }),
    );
    vi.stubGlobal('fetch', fetcher);

    warmSharedVideoAuthorization('/a');
    warmSharedVideoAuthorization('/b');
    warmSharedVideoAuthorization('/c');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/a']);

    deferred.get('/a')?.();
    await vi.waitFor(() => {
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/a', '/c']);
    });
  });

  it('waits for deliberate card intent before warming a shared source', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);

    scheduleSharedVideoAuthorizationWarmup('/hovered');
    await vi.advanceTimersByTimeAsync(399);
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/hovered?priority=warmup');
    const options = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(options).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    expect(options.keepalive).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('cancels a hover intent when the viewer leaves before the dwell period', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const cancel = scheduleSharedVideoAuthorizationWarmup('/left-card');
    cancel();
    await vi.advanceTimersByTimeAsync(500);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps only the latest completed hover intent behind an active warmup', async () => {
    vi.useFakeTimers();
    let finishActive: () => void = () => undefined;
    const fetcher = vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          if (url === '/active') finishActive = () => resolve(new Response(null, { status: 204 }));
        }),
    );
    vi.stubGlobal('fetch', fetcher);

    warmSharedVideoAuthorization('/active');
    scheduleSharedVideoAuthorizationWarmup('/stale');
    await vi.advanceTimersByTimeAsync(400);
    scheduleSharedVideoAuthorizationWarmup('/latest');
    await vi.advanceTimersByTimeAsync(400);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/active']);

    finishActive();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/active', '/latest?priority=warmup']);
  });

  it('starts a click warmup immediately and dedupes its earlier hover intent', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);

    scheduleSharedVideoAuthorizationWarmup('/clicked');
    warmSharedVideoAuthorization('/clicked');
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels an active hover before an explicitly chosen different video starts', async () => {
    vi.useFakeTimers();
    let hoveredSignal: AbortSignal | undefined;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/hovered?priority=warmup') {
        hoveredSignal = options?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          hoveredSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetcher);

    scheduleSharedVideoAuthorizationWarmup('/hovered');
    await vi.advanceTimersByTimeAsync(400);
    expect(hoveredSignal?.aborted).toBe(false);

    warmSharedVideoAuthorization('/chosen');
    expect(hoveredSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/hovered?priority=warmup', '/chosen']);
  });

  it('replaces a started hover with one interactive warmup when that same video is clicked', async () => {
    vi.useFakeTimers();
    let hoveredSignal: AbortSignal | undefined;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/clicked-after-hover?priority=warmup') {
        hoveredSignal = options?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          hoveredSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetcher);

    scheduleSharedVideoAuthorizationWarmup('/clicked-after-hover');
    await vi.advanceTimersByTimeAsync(400);
    warmSharedVideoAuthorization('/clicked-after-hover');

    expect(hoveredSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/clicked-after-hover?priority=warmup',
      '/clicked-after-hover',
    ]);
  });

  it('cancels all speculative hover work before a continuous recording opens', async () => {
    vi.useFakeTimers();
    let activeHoverSignal: AbortSignal | undefined;
    const fetcher = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/active-hover?priority=warmup') {
        activeHoverSignal = options?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          activeHoverSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetcher);

    scheduleSharedVideoAuthorizationWarmup('/active-hover');
    await vi.advanceTimersByTimeAsync(400);
    scheduleSharedVideoAuthorizationWarmup('/queued-hover');
    await vi.advanceTimersByTimeAsync(400);
    scheduleSharedVideoAuthorizationWarmup('/scheduled-hover');

    cancelCancellableSharedVideoAuthorizationHoverWork();
    expect(activeHoverSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/active-hover?priority=warmup']);
  });

  it('rewarms before the server-side shared-access proof expires', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);

    warmSharedVideoAuthorization('/shared');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(44_999);
    warmSharedVideoAuthorization('/shared');
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    warmSharedVideoAuthorization('/shared');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not refetch a successfully warmed source during its short client lifetime', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);

    warmSharedVideoAuthorization('/shared');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => warmSharedVideoAuthorization('/shared'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
