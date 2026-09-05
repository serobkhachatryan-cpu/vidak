/**
 * Bump when catalogue rules or persisted checkpoint layout changes and jobs
 * must rescan. Version 11 also preserves the authoritative chat context from
 * Messages-by-Chat responses, so valid shared videos whose envelopes omit a
 * duplicate `chatId` field remain displayed and playable after revalidation.
 */
export const VIDEO_SPACE_CATALOGUE_VERSION = 11;

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
