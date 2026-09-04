import type { InventoryCompleteness, InventoryDiscovery } from './video-space-model';

const activePollingDelayMs = 2_000;
const deferredPollingDelayMs = 5_000;
const rateLimitedPollingDelayMs = 10_000;

/**
 * Poll only while the server has background work to report. A terminal partial
 * result has a visible Retry action, so repeatedly starting new scans would
 * waste private W3DS requests without improving the result.
 */
export function libraryPollingDelayMs(input: {
  discovery?: InventoryDiscovery;
  completeness?: InventoryCompleteness;
}): number | undefined {
  const retrying = input.completeness?.retrying ?? 0;
  const deferred = input.completeness?.deferred ?? 0;
  const rateLimited = input.completeness?.retryRateLimited ?? 0;
  const hasBackgroundWork = input.discovery === 'refreshing' || retrying > 0 || deferred > 0;

  if (!hasBackgroundWork) return undefined;
  if (rateLimited > 0) return rateLimitedPollingDelayMs;
  if (retrying > 0 || deferred > 0) return deferredPollingDelayMs;
  return activePollingDelayMs;
}
