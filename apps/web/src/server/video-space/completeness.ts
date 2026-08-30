/**
 * Counts-only inventory completeness. Never include names, IDs, titles,
 * eNames, or other record content in the copy or the structured state.
 */
export interface InventoryCompleteness {
  indexed: number;
  expected: number;
  complete: boolean;
  retryNeeded: boolean;
}

export const completeInventory: InventoryCompleteness = {
  indexed: 0,
  expected: 0,
  complete: true,
  retryNeeded: false,
};

export function inventoryCompletenessCopy(state: InventoryCompleteness): string {
  const base = `${state.indexed} of ${state.expected} shared spaces indexed`;
  return state.complete && !state.retryNeeded ? `${base}.` : `${base}; retry needed.`;
}

export function createInventoryCompletenessTracker() {
  let expected = 0;
  let indexed = 0;
  let retryNeeded = false;

  return {
    expectSpace() {
      expected += 1;
    },
    indexSpace() {
      indexed += 1;
    },
    markRetry() {
      retryNeeded = true;
    },
    snapshot(): InventoryCompleteness {
      const complete = expected === indexed && !retryNeeded;
      return {
        indexed,
        expected,
        complete,
        retryNeeded: retryNeeded || indexed < expected,
      };
    },
  };
}

export type InventoryCompletenessTracker = ReturnType<typeof createInventoryCompletenessTracker>;
