/**
 * Counts-only inventory completeness. Never include names, IDs, titles,
 * eNames, or other record content in the copy or the structured state.
 */
export interface InventoryCompleteness {
  indexed: number;
  expected: number;
  denied: number;
  missing: number;
  complete: boolean;
  retryNeeded: boolean;
  retryUnavailable: number;
  retryRejected: number;
  retryRateLimited: number;
}

export const completeInventory: InventoryCompleteness = {
  indexed: 0,
  expected: 0,
  denied: 0,
  missing: 0,
  complete: true,
  retryNeeded: false,
  retryUnavailable: 0,
  retryRejected: 0,
  retryRateLimited: 0,
};

export function inventoryCompletenessCopy(state: InventoryCompleteness): string {
  const parts = [`${state.indexed} of ${state.expected} shared spaces indexed`];
  if (state.denied > 0) parts.push(`${state.denied} denied by current access`);
  if (state.missing > 0) parts.push(`${state.missing} not found`);
  const classified = `${parts[0]}${parts.length > 1 ? `; ${parts.slice(1).join('; ')}` : ''}`;
  if (state.complete && !state.retryNeeded) return `${classified}.`;
  return `${classified}; retry needed.`;
}

export function createInventoryCompletenessTracker() {
  let expected = 0;
  let indexed = 0;
  let denied = 0;
  let missing = 0;
  let retryNeeded = false;
  let retryUnavailable = 0;
  let retryRejected = 0;
  let retryRateLimited = 0;

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
    markRetry() {
      retryNeeded = true;
    },
    markRetryClass(kind: 'unavailable' | 'rejected' | 'rate_limited') {
      retryNeeded = true;
      if (kind === 'unavailable') retryUnavailable += 1;
      else if (kind === 'rejected') retryRejected += 1;
      else retryRateLimited += 1;
    },
    snapshot(): InventoryCompleteness {
      const classified = indexed + denied + missing;
      const complete = classified === expected && !retryNeeded;
      return {
        indexed,
        expected,
        denied,
        missing,
        complete,
        retryNeeded: retryNeeded || classified < expected,
        retryUnavailable,
        retryRejected,
        retryRateLimited,
      };
    },
  };
}

export type InventoryCompletenessTracker = ReturnType<typeof createInventoryCompletenessTracker>;
