/**
 * Ignore stale asynchronous results when a newer request has already started.
 * The tracker is intentionally framework-agnostic so pages can pair it with
 * cancellation where a transport supports AbortSignal.
 */
export function createLatestRequestTracker() {
  let current = 0;

  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(request: number): boolean {
      return request === current;
    },
    invalidate(): void {
      current += 1;
    },
  };
}

/**
 * Background polling should wait for the current request rather than repeatedly
 * cancelling it. A user-triggered refresh is intentionally allowed to replace it.
 */
export function shouldStartRequest(input: {
  hasActiveRequest: boolean;
  supersede?: boolean;
}): boolean {
  return input.supersede === true || !input.hasActiveRequest;
}
