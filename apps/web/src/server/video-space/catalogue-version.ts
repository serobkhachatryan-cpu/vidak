/**
 * Bump when catalogue rules or persisted checkpoint layout changes and jobs
 * must rescan. Version 17 rebuilds long-recording cards when a legacy
 * `mediaUri` merely aliases `mediaSegments[0]`, so the retained card contains
 * the whole ordered recording rather than its first short file. Version 16
 * retains the canonical CallSession vault separately
 * from recording-byte storage, so exact shared playback never reads a session
 * from the wrong eVault. Version 15 rebuilds CallSession cards with the
 * canonical recording-vault and CallSession-envelope pointers required for
 * the exact source-issued shared-playback grant. Version 14 rebuilds retained direct-history cards so the
 * viewer-vault Chat-envelope hint introduced in version 13 survives
 * de-duplication with older card metadata. Version 13 carries a viewer-vault
 * Chat-envelope hint for an O(1), current direct-share proof at playback.
 * Version 12 preserves a standalone `mediaUri` for call recordings. Version
 * 17 later distinguishes it from the legacy first-segment alias. Version 11
 * preserves the authoritative chat context from
 * Messages-by-Chat responses, so valid shared videos whose envelopes omit a
 * duplicate `chatId` field remain displayed and playable after revalidation.
 */
export const VIDEO_SPACE_CATALOGUE_VERSION = 17;

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
