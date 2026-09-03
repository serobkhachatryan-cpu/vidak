/** Bump when catalogue display rules change and completed inventory jobs must rescan. */
export const VIDEO_SPACE_CATALOGUE_VERSION = 6;

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
