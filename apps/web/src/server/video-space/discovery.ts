/**
 * Progressive inventory discovery. Counts and timings only — never names,
 * eNames, IDs, tokens, or media URLs.
 */
import type { InventoryCompleteness } from './completeness';

export type InventoryScope = 'owned' | 'shared';

export type InventoryDiscovery = 'refreshing' | 'partial' | 'complete';

export type InventoryCacheOutcome = 'hit' | 'miss' | 'coalesced';

export interface InventorySourceCounts {
  personalPages: number;
  sharedSpaces: number;
  failed: number;
}

export interface InventoryMetrics {
  cache: InventoryCacheOutcome;
  firstResultMs: number;
  completionMs?: number;
  sourceCounts: InventorySourceCounts;
}

export function parseInventoryScope(value: string | null | undefined): InventoryScope | undefined {
  if (value === 'owned' || value === 'shared') return value;
  return undefined;
}

/**
 * A scan still running is refreshing. A finished scan with missing sources or
 * retries is partial. Only a finished scan with nothing left to retry is complete.
 */
export function inventoryDiscovery(input: {
  scanning: boolean;
  completeness: InventoryCompleteness;
}): InventoryDiscovery {
  if (input.scanning) return 'refreshing';
  if (!input.completeness.complete || input.completeness.retryNeeded) return 'partial';
  return 'complete';
}

export function emptySourceCounts(): InventorySourceCounts {
  return { personalPages: 0, sharedSpaces: 0, failed: 0 };
}

export function formatInventoryMetricsLog(input: {
  discovery: InventoryDiscovery;
  completeness: InventoryCompleteness;
  metrics: InventoryMetrics;
}): string {
  const completion =
    input.metrics.completionMs === undefined ? '-' : String(input.metrics.completionMs);
  return [
    'video-space-inventory',
    `cache=${input.metrics.cache}`,
    `discovery=${input.discovery}`,
    `first_result_ms=${input.metrics.firstResultMs}`,
    `completion_ms=${completion}`,
    `sources_personal=${input.metrics.sourceCounts.personalPages}`,
    `sources_shared=${input.metrics.sourceCounts.sharedSpaces}`,
    `sources_failed=${input.metrics.sourceCounts.failed}`,
    `retry_rate_limited=${input.completeness.retryRateLimited}`,
  ].join(' ');
}
