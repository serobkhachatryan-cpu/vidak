/**
 * Bump when catalogue rules or persisted checkpoint layout changes and jobs
 * must rescan. Version 22 seals a currently verified GroupManifest envelope
 * id into private group playback streams, allowing a point read at Watch
 * time instead of a broad shared-vault metadata search. Version 21 retains a
 * viewer-owned local File-reference proof
 * when the matching shared Message was discovered first, so existing cards
 * can reopen through the viewer's eVault rather than an obsolete chat
 * history route. Version 20 requeues shared-file warming under the durable,
 * server-only canonical eVault redirect cache and its stricter per-vault
 * background throttle, so existing retained cards benefit after deploy.
 * Version 19 schedules a server-only canonical File metadata
 * prewarm for accepted video messages, so retained legacy shared cards avoid
 * a new foreground eVault GraphQL read on their first Watch. Version 18 seals
 * a server-only context HMAC into every shared
 * card and its stream segments so a confirmed revoked share can be retired
 * without persisting or exposing source identifiers. Version 17 rebuilds long-recording cards when a legacy
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
export const VIDEO_SPACE_CATALOGUE_VERSION = 22;

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
