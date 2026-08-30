import { describe, expect, it } from 'vitest';
import {
  createInventoryCompletenessTracker,
  inventoryCompletenessCopy,
} from './completeness';

describe('inventory completeness', () => {
  it('uses counts only when a source read is incomplete', () => {
    const tracker = createInventoryCompletenessTracker();
    tracker.expectSpace();
    tracker.expectSpace();
    tracker.indexSpace();
    tracker.markRetry();
    const state = tracker.snapshot();
    expect(state).toEqual({
      indexed: 1,
      expected: 2,
      denied: 0,
      missing: 0,
      complete: false,
      retryNeeded: true,
    });
    expect(inventoryCompletenessCopy(state)).toBe(
      '1 of 2 shared spaces indexed; retry needed.',
    );
    expect(inventoryCompletenessCopy(state)).not.toMatch(/@|[a-f0-9-]{8,}|group|chat|title/i);
  });

  it('separates current-access denials and missing spaces from retryable reads', () => {
    const tracker = createInventoryCompletenessTracker();
    tracker.expectSpace();
    tracker.expectSpace();
    tracker.expectSpace();
    tracker.indexSpace();
    tracker.denySpace();
    tracker.missSpace();
    const state = tracker.snapshot();
    expect(state).toEqual({
      indexed: 1,
      expected: 3,
      denied: 1,
      missing: 1,
      complete: true,
      retryNeeded: false,
    });
    expect(inventoryCompletenessCopy(state)).toBe(
      '1 of 3 shared spaces indexed; 1 denied by current access; 1 not found.',
    );
  });

  it('reports a finished inventory without asking for a retry', () => {
    const tracker = createInventoryCompletenessTracker();
    tracker.expectSpace();
    tracker.indexSpace();
    expect(inventoryCompletenessCopy(tracker.snapshot())).toBe(
      '1 of 1 shared spaces indexed.',
    );
  });
});
