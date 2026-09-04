/**
 * Bump when catalogue rules or persisted checkpoint layout changes and jobs
 * must rescan. Version 9 rebuilds shared entries with viewer-bound playback
 * grants and server-only source proof instead of preserving legacy
 * metadata-only records.
 */
export const VIDEO_SPACE_CATALOGUE_VERSION = 9;

export function readCatalogueVersion(ledger: Record<string, unknown>): number {
  const value = ledger.catalogueVersion;
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

/** Running legacy checkpoints had no version and must resume their exact cursor. */
export function hasCatalogueVersion(ledger: Record<string, unknown>): boolean {
  const value = ledger.catalogueVersion;
  return typeof value === 'number' && Number.isFinite(value);
}

export function isStaleCatalogueVersion(ledger: Record<string, unknown>): boolean {
  return readCatalogueVersion(ledger) < VIDEO_SPACE_CATALOGUE_VERSION;
}
