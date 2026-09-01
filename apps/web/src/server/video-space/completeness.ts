/**
 * Counts-only inventory completeness. Never include names, IDs, titles,
 * eNames, or other record content in the copy or the structured state.
 */

/** Documented eVault pages and grants actually scanned. Counts only. */
export interface InventoryCoverage {
  chatPages: number;
  messagePages: number;
  filePages: number;
  w3dsFilePages: number;
  groupManifestPages: number;
  callSessionPages: number;
  groupHistories: number;
  directChats: number;
  referenceGrants: number;
  officialChatGrants: number;
}

export type InventoryCoveragePageKind =
  | 'chatPages'
  | 'messagePages'
  | 'filePages'
  | 'w3dsFilePages'
  | 'groupManifestPages'
  | 'callSessionPages';

export const emptyInventoryCoverage: InventoryCoverage = {
  chatPages: 0,
  messagePages: 0,
  filePages: 0,
  w3dsFilePages: 0,
  groupManifestPages: 0,
  callSessionPages: 0,
  groupHistories: 0,
  directChats: 0,
  referenceGrants: 0,
  officialChatGrants: 0,
};

/** Counts-only media eligibility. Reasons are documented classes, never record IDs. */
export type InventoryUnresolvedReason =
  | 'missing_w3ds_file_uri'
  | 'resolver_denied'
  | 'resolver_missing'
  | 'resolver_unavailable';

export interface InventoryMediaCounts {
  candidates: number;
  accepted: number;
  excludedNonVideo: number;
  unresolved: Partial<Record<InventoryUnresolvedReason, number>>;
}

export const emptyInventoryMediaCounts: InventoryMediaCounts = {
  candidates: 0,
  accepted: 0,
  excludedNonVideo: 0,
  unresolved: {},
};

export function coveragePageTotal(coverage: InventoryCoverage | undefined): number {
  if (!coverage) return 0;
  return (
    coverage.chatPages +
    coverage.messagePages +
    coverage.filePages +
    coverage.w3dsFilePages +
    coverage.groupManifestPages +
    coverage.callSessionPages
  );
}

export interface InventoryCompleteness {
  indexed: number;
  expected: number;
  denied: number;
  missing: number;
  /** Spaces that exhausted retries with a terminal, reported failure. */
  failed?: number;
  complete: boolean;
  retryNeeded: boolean;
  retryUnavailable: number;
  retryRejected: number;
  retryRateLimited: number;
  /** Sources currently queued for background retry. Zero once the scan is terminal. */
  retrying?: number;
  coverage?: InventoryCoverage;
  media?: InventoryMediaCounts;
}

export const completeInventory: InventoryCompleteness = {
  indexed: 0,
  expected: 0,
  denied: 0,
  missing: 0,
  failed: 0,
  complete: true,
  retryNeeded: false,
  retryUnavailable: 0,
  retryRejected: 0,
  retryRateLimited: 0,
  retrying: 0,
  coverage: { ...emptyInventoryCoverage },
  media: { ...emptyInventoryMediaCounts, unresolved: {} },
};

export function inventoryCompletenessCopy(state: InventoryCompleteness): string {
  const parts = [`${state.indexed} of ${state.expected} shared spaces indexed`];
  if (state.denied > 0) parts.push(`${state.denied} denied by current access`);
  if (state.missing > 0) parts.push(`${state.missing} not found`);
  if (state.failed) parts.push(`${state.failed} failed`);
  const retrying = state.retrying ?? 0;
  if (retrying > 0) parts.push(`retrying ${retrying}`);
  const classified = `${parts[0]}${parts.length > 1 ? `; ${parts.slice(1).join('; ')}` : ''}`;
  if (state.complete && !state.retryNeeded) return `${classified}.`;
  if (retrying > 0) return `${classified}.`;
  return `${classified}; retry needed.`;
}

export function createInventoryCompletenessTracker() {
  let expected = 0;
  let indexed = 0;
  let denied = 0;
  let missing = 0;
  let failed = 0;
  let retryNeeded = false;
  let retryUnavailable = 0;
  let retryRejected = 0;
  let retryRateLimited = 0;
  let retrying = 0;
  let scanFinished = false;
  const coverage: InventoryCoverage = { ...emptyInventoryCoverage };
  const media: InventoryMediaCounts = { ...emptyInventoryMediaCounts, unresolved: {} };

  return {
    expectSpace() {
      expected += 1;
    },
    indexSpace() {
      indexed += 1;
    },
    denySpace() {
      denied += 1;
    },
    missSpace() {
      missing += 1;
    },
    failSpace() {
      failed += 1;
    },
    markRetry() {
      retryNeeded = true;
    },
    markRetryClass(kind: 'unavailable' | 'rejected' | 'rate_limited') {
      if (kind === 'unavailable') retryUnavailable += 1;
      else if (kind === 'rejected') retryRejected += 1;
      else retryRateLimited += 1;
    },
    queueRetry() {
      retrying += 1;
    },
    finishRetry() {
      retrying = Math.max(0, retrying - 1);
    },
    /** Drop stale persisted retry counts when the rebuilt queue has fewer retry rows. */
    reconcileRetrying(openCount: number) {
      retrying = Math.max(0, openCount);
    },
    failRetry(kind: 'unavailable' | 'rejected' | 'rate_limited') {
      retrying = Math.max(0, retrying - 1);
      this.markRetryClass(kind);
    },
    recordPage(kind: InventoryCoveragePageKind) {
      coverage[kind] += 1;
    },
    recordGroupHistory() {
      coverage.groupHistories += 1;
    },
    recordDirectChat() {
      coverage.directChats += 1;
    },
    recordGrant(kind: 'reference' | 'official') {
      if (kind === 'reference') coverage.referenceGrants += 1;
      else coverage.officialChatGrants += 1;
    },
    recordCandidate() {
      media.candidates += 1;
    },
    recordAccepted() {
      media.accepted += 1;
    },
    recordExcludedNonVideo() {
      media.excludedNonVideo += 1;
    },
    recordUnresolved(reason: InventoryUnresolvedReason) {
      media.unresolved[reason] = (media.unresolved[reason] ?? 0) + 1;
    },
    /** The work queue is empty; remaining space gaps are terminal, not pending. */
    markScanFinished() {
      scanFinished = true;
      retrying = 0;
      retryNeeded = false;
    },
    hydrate(state: InventoryCompleteness) {
      expected = state.expected;
      indexed = state.indexed;
      denied = state.denied;
      missing = state.missing;
      failed = state.failed ?? 0;
      retryNeeded = state.retryNeeded;
      retryUnavailable = state.retryUnavailable;
      retryRejected = state.retryRejected;
      retryRateLimited = state.retryRateLimited;
      retrying = state.retrying ?? 0;
      if (state.coverage) Object.assign(coverage, state.coverage);
      if (state.media) {
        media.candidates = state.media.candidates;
        media.accepted = state.media.accepted;
        media.excludedNonVideo = state.media.excludedNonVideo;
        media.unresolved = { ...state.media.unresolved };
      }
    },
    snapshot(): InventoryCompleteness {
      const classified = indexed + denied + missing + failed;
      const complete = scanFinished
        ? retrying === 0 && classified >= expected
        : classified === expected && retrying === 0 && !retryNeeded;
      return {
        indexed,
        expected,
        denied,
        missing,
        failed,
        complete,
        retryNeeded: scanFinished ? false : retryNeeded || classified + retrying < expected,
        retryUnavailable,
        retryRejected,
        retryRateLimited,
        retrying,
        coverage: { ...coverage },
        media: { ...media, unresolved: { ...media.unresolved } },
      };
    },
  };
}

export type InventoryCompletenessTracker = ReturnType<typeof createInventoryCompletenessTracker>;
