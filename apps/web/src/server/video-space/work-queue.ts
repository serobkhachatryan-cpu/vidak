import { mapPool } from './map-pool';

/**
 * Drain a retry-aware work queue. Ready items run with bounded concurrency.
 * Items with a future `notBefore` wait; the same item (including its cursor)
 * is resumed instead of being dropped.
 */
export interface DeferredWork {
  attempts: number;
  notBefore?: number;
}

export async function drainDeferredQueue<T extends DeferredWork>(
  queue: T[],
  concurrency: number,
  process: (item: T) => Promise<void>,
  options?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    maxWaitMs?: number;
  },
): Promise<void> {
  const now = options?.now ?? (() => Date.now());
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxWaitMs = options?.maxWaitMs ?? 5_000;

  while (queue.length) {
    const timestamp = now();
    const ready: T[] = [];
    const waiting: T[] = [];
    for (const item of queue) {
      if ((item.notBefore ?? 0) <= timestamp) ready.push(item);
      else waiting.push(item);
    }
    queue.length = 0;
    queue.push(...waiting);
    if (ready.length === 0) {
      const wakeAt = Math.min(...waiting.map((item) => item.notBefore ?? timestamp));
      await sleep(Math.min(Math.max(wakeAt - now(), 10), maxWaitMs));
      continue;
    }
    await mapPool(ready, concurrency, process);
  }
}
