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

/**
 * Drain work fairly across eVaults: one GraphQL request per vault at a time,
 * many vaults in parallel. A Message backlog on one vault cannot starve
 * Chat / File / GroupManifest / call-session work on another.
 */
export async function drainFairVaultQueue<T extends DeferredWork>(
  queue: T[],
  process: (item: T) => Promise<void>,
  options: {
    vaultKey: (item: T) => string;
    priority: (item: T) => number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    maxWaitMs?: number;
    maxVaultsPerWave?: number;
    vaultNotBefore?: (vaultKey: string, now: number) => number | Promise<number>;
    persist?: (queue: T[]) => void | Promise<void>;
  },
): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const maxVaults = options.maxVaultsPerWave ?? 8;

  while (queue.length) {
    const timestamp = now();
    const waiting: T[] = [];
    const readyByVault = new Map<string, T[]>();
    for (const item of queue) {
      const vault = options.vaultKey(item);
      const gated = options.vaultNotBefore ? await options.vaultNotBefore(vault, timestamp) : 0;
      if ((item.notBefore ?? 0) > timestamp || gated > timestamp) {
        waiting.push(item);
        continue;
      }
      const list = readyByVault.get(vault) ?? [];
      list.push(item);
      readyByVault.set(vault, list);
    }
    queue.length = 0;
    queue.push(...waiting);
    if (readyByVault.size === 0) {
      const gatedTimes = await Promise.all(
        waiting.map(async (item) => {
          const vaultWait = options.vaultNotBefore
            ? await options.vaultNotBefore(options.vaultKey(item), timestamp)
            : 0;
          return Math.max(item.notBefore ?? timestamp, vaultWait);
        }),
      );
      const wakeAt = gatedTimes.length ? Math.min(...gatedTimes) : timestamp + maxWaitMs;
      await options.persist?.(queue);
      await sleep(Math.min(Math.max(wakeAt - now(), 10), maxWaitMs));
      continue;
    }
    const chosen: T[] = [];
    const deferred: T[] = [];
    let vaults = 0;
    for (const items of readyByVault.values()) {
      items.sort((a, b) => options.priority(a) - options.priority(b) || a.attempts - b.attempts);
      if (vaults < maxVaults) {
        const next = items.shift();
        if (next) chosen.push(next);
        vaults += 1;
      }
      deferred.push(...items);
    }
    queue.push(...deferred);
    await mapPool(chosen, chosen.length || 1, process);
    await options.persist?.(queue);
  }
}
