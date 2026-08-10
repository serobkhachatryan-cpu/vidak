/**
 * Thumbnail URL helpers shared by clients, UI, and server validation.
 * Ephemeral `blob:` / `data:` URLs must never be persisted or rendered as durable media.
 */

export function isEphemeralThumbnailUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith('blob:') || normalized.startsWith('data:');
}

/**
 * True when `url` is safe to render in an `<img>` as a durable or same-origin source.
 * Rejects empty values and ephemeral `blob:` / `data:` URLs.
 */
export function isRenderableThumbnailUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || isEphemeralThumbnailUrl(trimmed)) return false;
  if (trimmed.startsWith('/')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalizes a thumbnail URL for persistence / public API responses.
 * Ephemeral and otherwise unsafe values become an empty string.
 */
export function normalizePersistedThumbnailUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || isEphemeralThumbnailUrl(trimmed)) return '';
  return isRenderableThumbnailUrl(trimmed) ? trimmed : '';
}
