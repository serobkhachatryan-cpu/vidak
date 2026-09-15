import { createExpiringMemoryCache } from './expiring-memory-cache';
import type { VideoSpaceLibraryItem } from './video-space-model';

const libraryMemoryLifetimeMs = 2 * 60 * 1_000;

type LibraryMemory = {
  get(userId: string, itemId: string): VideoSpaceLibraryItem | undefined;
  set(userId: string, items: readonly VideoSpaceLibraryItem[]): void;
  /** Removes only one known stale card for the current signed-in account. */
  remove(userId: string, itemId: string): void;
};

/**
 * Keeps a recently rendered private library in RAM only, scoped to the signed-
 * in account. It avoids a second catalogue request when Watch opens from a
 * card, while a fresh request still reconciles the item in the background.
 */
export function createVideoSpaceLibraryMemory(options?: { now?: () => number }): LibraryMemory {
  const cache = createExpiringMemoryCache<VideoSpaceLibraryItem[]>({
    maxAgeMs: libraryMemoryLifetimeMs,
    maxEntries: 2,
    ...(options?.now ? { now: options.now } : {}),
  });
  return {
    get(userId, itemId) {
      const item = cache.get(userId)?.find((candidate) => candidate.id === itemId);
      return item ? cloneItem(item) : undefined;
    },
    set(userId, items) {
      cache.set(userId, items.map(cloneItem));
    },
    remove(userId, itemId) {
      const items = cache.get(userId);
      if (!items) return;
      const retained = items.filter((item) => item.id !== itemId);
      if (retained.length === items.length) return;
      if (retained.length === 0) {
        cache.clear(userId);
        return;
      }
      cache.set(userId, retained.map(cloneItem));
    },
  };
}

export const videoSpaceLibraryMemory = createVideoSpaceLibraryMemory();

function cloneItem(item: VideoSpaceLibraryItem): VideoSpaceLibraryItem {
  return {
    ...item,
    ...(item.streamIds ? { streamIds: [...item.streamIds] } : {}),
  };
}
