/**
 * Progressive inventory discovery. Counts and timings only — never names,
 * eNames, IDs, tokens, or media URLs.
 */
import type { InventoryCompleteness } from './completeness';
import { coveragePageTotal } from './completeness';

export type InventoryScope = 'all' | 'owned' | 'shared';

export type InventoryDiscovery = 'refreshing' | 'partial' | 'complete';

/** Scanner progress events. `batch` is any completed source/page/space; `done` is terminal. */
export type InventoryScanPhase = 'batch' | 'done';

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
  if (value === 'all' || value === 'owned' || value === 'shared') return value;
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
  const deferred = input.completeness.deferred ?? 0;
  const retrying = input.completeness.retrying ?? 0;
  if (input.scanning || deferred > 0 || retrying > 0) return 'refreshing';
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
  const coverage = input.completeness.coverage;
  const pages = coveragePageTotal(coverage);
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
    `pages=${pages}`,
    `pages_requested=${coverage?.pagesRequested ?? 0}`,
    `pages_processed=${coverage?.pagesProcessed ?? 0}`,
    `histories=${coverage?.groupHistories ?? 0}`,
    `directs=${coverage?.directChats ?? 0}`,
    `grants_reference=${coverage?.referenceGrants ?? 0}`,
    `grants_official=${coverage?.officialChatGrants ?? 0}`,
    `pages_chat=${coverage?.chatPages ?? 0}`,
    `pages_message=${coverage?.messagePages ?? 0}`,
    `pages_file=${coverage?.filePages ?? 0}`,
    `pages_w3ds_file=${coverage?.w3dsFilePages ?? 0}`,
    `pages_manifest=${coverage?.groupManifestPages ?? 0}`,
    `pages_call=${coverage?.callSessionPages ?? 0}`,
    `media_candidates=${input.completeness.media?.candidates ?? 0}`,
    `media_accepted=${input.completeness.media?.accepted ?? 0}`,
    `media_excluded_non_video=${input.completeness.media?.excludedNonVideo ?? 0}`,
    `media_unresolved=${unresolvedTotal(input.completeness.media?.unresolved)}`,
    ...unresolvedReasonParts(input.completeness.media?.unresolved),
  ].join(' ');
}

function unresolvedTotal(unresolved: Record<string, number> | undefined): number {
  if (!unresolved) return 0;
  return Object.values(unresolved).reduce((sum, count) => sum + count, 0);
}

function unresolvedReasonParts(unresolved: Record<string, number> | undefined): string[] {
  if (!unresolved) return [];
  return Object.entries(unresolved)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `unresolved_${reason}=${count}`);
}
