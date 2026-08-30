import type { PublicViewRecordResult, Video } from '@w3ds/types';

/** Count a watch-page view after this many seconds of playback. */
export const MEANINGFUL_PLAYBACK_SECONDS = 3;

/** Short videos count once this fraction of duration has played. */
export const MEANINGFUL_PLAYBACK_FRACTION = 0.25;

export function hasReachedMeaningfulPlayback(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(currentTime) || currentTime <= 0) return false;
  if (!Number.isFinite(duration) || duration <= 0) {
    return currentTime >= MEANINGFUL_PLAYBACK_SECONDS;
  }
  const threshold = Math.min(MEANINGFUL_PLAYBACK_SECONDS, duration * MEANINGFUL_PLAYBACK_FRACTION);
  return currentTime >= threshold;
}

export function createPublicViewRecorder(
  record: (publicVideoId: string) => Promise<PublicViewRecordResult>,
): {
  onPlaybackProgress: (
    publicVideoId: string,
    currentTime: number,
    duration: number,
  ) => Promise<PublicViewRecordResult | undefined>;
} {
  let sent = false;
  return {
    async onPlaybackProgress(publicVideoId, currentTime, duration) {
      const id = publicVideoId.trim();
      if (sent || !id || !hasReachedMeaningfulPlayback(currentTime, duration)) {
        return undefined;
      }
      sent = true;
      return record(id);
    },
  };
}

type PublicVideoCache =
  | { items: readonly Video[]; pages?: undefined }
  | { pages: readonly { items: readonly Video[] }[]; items?: undefined }
  | { items?: readonly Video[]; pages?: readonly { items: readonly Video[] }[] };

export function replacePublicVideoInPages<T extends PublicVideoCache>(current: T, video: Video): T {
  const matches = (item: Video) =>
    item.id === video.id ||
    (Boolean(item.publicVideoId) && item.publicVideoId === video.publicVideoId);

  if (Array.isArray(current.pages)) {
    return {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        items: page.items.map((item: Video) => (matches(item) ? video : item)),
      })),
    };
  }

  if (Array.isArray(current.items)) {
    return {
      ...current,
      items: current.items.map((item: Video) => (matches(item) ? video : item)),
    };
  }

  return current;
}
