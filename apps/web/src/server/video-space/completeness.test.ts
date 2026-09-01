import { describe, expect, it } from 'vitest';
import {
  createInventoryCompletenessTracker,
  emptyInventoryCoverage,
  emptyInventoryMediaCounts,
  inventoryCompletenessCopy,
  inventoryJobNeedsDrain,
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
      failed: 0,
      complete: false,
      retryNeeded: true,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
      retrying: 0,
      coverage: emptyInventoryCoverage,
      media: { ...emptyInventoryMediaCounts, unresolved: {} },
    });
    expect(inventoryCompletenessCopy(state)).toBe('1 of 2 shared spaces indexed; retry needed.');
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
      failed: 0,
      complete: true,
      retryNeeded: false,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
      retrying: 0,
      coverage: emptyInventoryCoverage,
      media: { ...emptyInventoryMediaCounts, unresolved: {} },
    });
    expect(inventoryCompletenessCopy(state)).toBe(
      '1 of 3 shared spaces indexed; 1 denied by current access; 1 not found.',
    );
  });

  it('reports a finished inventory without asking for a retry', () => {
    const tracker = createInventoryCompletenessTracker();
    tracker.expectSpace();
    tracker.indexSpace();
    expect(inventoryCompletenessCopy(tracker.snapshot())).toBe('1 of 1 shared spaces indexed.');
  });

  it('tracks in-flight retries separately from a terminal retry needed state', () => {
    const tracker = createInventoryCompletenessTracker();
    tracker.expectSpace();
    tracker.expectSpace();
    tracker.indexSpace();
    tracker.queueRetry();
    const retrying = tracker.snapshot();
    expect(retrying.complete).toBe(false);
    expect(retrying.retryNeeded).toBe(false);
    expect(retrying.retrying).toBe(1);
    expect(inventoryCompletenessCopy(retrying)).toBe('1 of 2 shared spaces indexed; retrying 1.');
    tracker.finishRetry();
    tracker.indexSpace();
    expect(tracker.snapshot()).toMatchObject({ complete: true, retrying: 0, retryNeeded: false });
  });

  it('treats a terminal space failure as classified so every space can complete', () => {
    const tracker = createInventoryCompletenessTracker();
    for (let i = 0; i < 7; i += 1) tracker.expectSpace();
    tracker.indexSpace();
    tracker.indexSpace();
    tracker.indexSpace();
    tracker.denySpace();
    tracker.missSpace();
    tracker.failSpace();
    tracker.failSpace();
    const state = tracker.snapshot();
    expect(state.complete).toBe(true);
    expect(state.retryNeeded).toBe(false);
    expect(state.failed).toBe(2);
    expect(state.coverage).toEqual(emptyInventoryCoverage);
    expect(inventoryCompletenessCopy(state)).toBe(
      '3 of 7 shared spaces indexed; 1 denied by current access; 1 not found; 2 failed.',
    );
  });

  it('records documented page and grant counts without treating space totals as inventory', () => {
    const tracker = createInventoryCompletenessTracker();
    tracker.expectSpace();
    tracker.indexSpace();
    tracker.recordPage('chatPages');
    tracker.recordPage('messagePages');
    tracker.recordPage('messagePages');
    tracker.recordGroupHistory();
    tracker.recordDirectChat();
    tracker.recordGrant('reference');
    tracker.recordGrant('official');
    const state = tracker.snapshot();
    expect(state.complete).toBe(true);
    expect(state.indexed).toBe(1);
    expect(state.coverage).toEqual({
      ...emptyInventoryCoverage,
      chatPages: 1,
      messagePages: 2,
      groupHistories: 1,
      directChats: 1,
      referenceGrants: 1,
      officialChatGrants: 1,
    });
  });

  it('counts candidate, accepted, excluded, and unresolved media without identifiers', () => {
    const tracker = createInventoryCompletenessTracker();
    tracker.recordCandidate();
    tracker.recordCandidate();
    tracker.recordCandidate();
    tracker.recordAccepted();
    tracker.recordExcludedNonVideo();
    tracker.recordUnresolved('missing_w3ds_file_uri');
    expect(tracker.snapshot().media).toEqual({
      candidates: 3,
      accepted: 1,
      excludedNonVideo: 1,
      unresolved: { missing_w3ds_file_uri: 1 },
    });
    expect(JSON.stringify(tracker.snapshot().media)).not.toMatch(/@|http|w3ds:\/\//i);
  });

  it('becomes terminal only after the scan queue is finished, even when no spaces were expected yet', () => {
    const tracker = createInventoryCompletenessTracker();
    expect(tracker.snapshot().complete).toBe(true);
    tracker.markRetry();
    tracker.queueRetry();
    expect(tracker.snapshot().complete).toBe(false);
    expect(tracker.snapshot().retrying).toBe(1);
    tracker.markScanFinished();
    expect(tracker.snapshot().complete).toBe(true);
    expect(tracker.snapshot().retryNeeded).toBe(false);
    expect(tracker.snapshot().retrying).toBe(0);
  });

  it('does not report complete after scan finished while spaces remain unclassified', () => {
    const tracker = createInventoryCompletenessTracker();
    for (let i = 0; i < 12; i += 1) tracker.expectSpace();
    tracker.failSpace();
    tracker.markScanFinished();
    expect(tracker.snapshot()).toMatchObject({
      expected: 12,
      failed: 1,
      complete: false,
      retrying: 0,
    });
  });

  it('keeps falsely complete persisted jobs on the background drain list', () => {
    expect(
      inventoryJobNeedsDrain({
        status: 'complete',
        completeness: {
          indexed: 0,
          expected: 12,
          denied: 0,
          missing: 0,
          failed: 1,
          complete: true,
          retryNeeded: false,
          retryUnavailable: 0,
          retryRejected: 0,
          retryRateLimited: 10,
          retrying: 0,
        },
        ledger: { drainFinished: true, remaining: [['@group.w3id', 2]] },
      }),
    ).toBe(true);
  });
});
