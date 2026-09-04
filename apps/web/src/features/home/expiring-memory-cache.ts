export interface ExpiringMemoryCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(key?: string): void;
}

/**
 * Keeps short-lived UI data in the current JavaScript process only. It never
 * uses browser storage, so private library data disappears on a page reload.
 */
export function createExpiringMemoryCache<T>({
  maxAgeMs,
  maxEntries = 3,
  now = Date.now,
}: {
  maxAgeMs: number;
  maxEntries?: number;
  now?: () => number;
}): ExpiringMemoryCache<T> {
  const entries = new Map<string, { savedAt: number; value: T }>();

  const prune = (currentTime: number) => {
    for (const [key, entry] of entries) {
      if (currentTime - entry.savedAt >= maxAgeMs) entries.delete(key);
    }
  };

  return {
    get(key) {
      const currentTime = now();
      prune(currentTime);
      return entries.get(key)?.value;
    },
    set(key, value) {
      const currentTime = now();
      prune(currentTime);
      entries.delete(key);
      entries.set(key, { savedAt: currentTime, value });
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) return;
        entries.delete(oldestKey);
      }
    },
    clear(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}
