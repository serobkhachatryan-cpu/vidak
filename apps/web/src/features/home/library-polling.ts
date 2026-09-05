import type { InventoryCompleteness, InventoryDiscovery } from './video-space-model';

// Discovery now continues on the server-side durable queue. The browser only
// needs occasional progress updates; polling the full private catalogue every
// couple of seconds makes the library compete with video playback.
const activePollingDelayMs = 15_000;
const deferredPollingDelayMs = 20_000;
const rateLimitedPollingDelayMs = 30_000;

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
  const hasBackgroundWork = input.discovery === 'refreshing';

  if (!hasBackgroundWork) return undefined;
  if (rateLimited > 0) return rateLimitedPollingDelayMs;
  if (retrying > 0 || deferred > 0) return deferredPollingDelayMs;
  return activePollingDelayMs;
}
