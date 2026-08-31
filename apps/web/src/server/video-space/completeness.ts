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
  const coverage: InventoryCoverage = { ...emptyInventoryCoverage };

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
    snapshot(): InventoryCompleteness {
      const classified = indexed + denied + missing + failed;
      const complete = classified === expected && retrying === 0 && !retryNeeded;
      return {
        indexed,
        expected,
        denied,
        missing,
        failed,
        complete,
        retryNeeded: retryNeeded || classified + retrying < expected,
        retryUnavailable,
        retryRejected,
        retryRateLimited,
        retrying,
        coverage: { ...coverage },
      };
    },
  };
}

export type InventoryCompletenessTracker = ReturnType<typeof createInventoryCompletenessTracker>;
