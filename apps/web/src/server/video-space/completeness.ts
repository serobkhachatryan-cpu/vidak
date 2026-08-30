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
}

export const completeInventory: InventoryCompleteness = {
  indexed: 0,
  expected: 0,
  denied: 0,
  missing: 0,
  complete: true,
  retryNeeded: false,
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
      };
    },
  };
}

export type InventoryCompletenessTracker = ReturnType<typeof createInventoryCompletenessTracker>;
