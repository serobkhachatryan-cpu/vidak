/**
 * Same-origin anonymous content path for a published public/unlisted video asset.
 * Uses only the opaque `publicVideoId` and asset id — never storage keys or draft ids.
 */
export function publicMediaContentPath(publicVideoId: string, assetId: string): string {
  return `/api/videos/public/${encodeURIComponent(publicVideoId)}/media/${encodeURIComponent(assetId)}/content`;
}

/**
 * Same-origin anonymous primary media stream for a published public/unlisted video.
 * Uses only the opaque `publicVideoId` — never storage keys, draft ids, or asset ids.
 */
export function publicPrimaryMediaPath(publicVideoId: string): string {
  return `/api/videos/public/${encodeURIComponent(publicVideoId)}/media`;
}

/** Browser watch path that uses only the opaque public video identifier. */
export function publicVideoWatchPath(publicVideoId: string): string {
  return `/watch/${encodeURIComponent(publicVideoId)}`;
}

/** True when `id` looks like an opaque public video identifier (`pub_…`). */
export function isPublicVideoId(id: string): boolean {
  return id.trim().startsWith('pub_');
}
