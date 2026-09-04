import { describe, expect, it } from 'vitest';
import { createLatestRequestTracker } from './latest-request';

describe('latest request tracker', () => {
  it('accepts only the most recent request result', () => {
    const tracker = createLatestRequestTracker();
    const first = tracker.next();
    const second = tracker.next();

    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
  });

  it('invalidates pending results when a view is disposed', () => {
    const tracker = createLatestRequestTracker();
    const request = tracker.next();

    tracker.invalidate();

    expect(tracker.isCurrent(request)).toBe(false);
  });
});
