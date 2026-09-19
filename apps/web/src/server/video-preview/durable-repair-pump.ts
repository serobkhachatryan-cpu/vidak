import 'server-only';

import type { AuthUser } from '@w3ds/auth';
import type { MeshengerVideo } from '../meshenger-video-library';
import { reportOperationalEvent } from '../ops-observability';
import { getInventoryJobStore, type InventoryJobRecord } from '../video-space/job-store';
import { getVideoPreviewService } from './preview-runtime';

const repairIntervalMs = 5 * 60 * 1000;

type DurablePreviewRepairDependencies = {
  listStoredJobs: () => Promise<
    ReadonlyArray<Pick<InventoryJobRecord, 'ownerEName' | 'ownerEVaultUri'>>
  >;
  loadJob: (ownerEName: string) => Promise<InventoryJobRecord | undefined>;
  scheduleDurableLibraryBackfill: (
    viewer: Pick<AuthUser, 'eName'>,
    items: ReadonlyArray<{ streamIds?: readonly string[] }>,
    options?: { retryFailed?: boolean },
  ) => Promise<void>;
};

let started = false;
let activeRepair: Promise<void> | undefined;
let startupTimer: ReturnType<typeof setTimeout> | undefined;
let repairInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Schedules server-only repair sweeps after a process starts.
 *
 * Historical inventory cards retain sealed, viewer-bound stream grants. The
 * sweep never dereferences a retained grant directly. It passes the original,
 * signed grant to the existing low-priority queue, which renews it only when
 * the one-at-a-time worker is ready to execute, then performs the current
 * eVault File/source authorization before it reads a single media byte. There
 * is intentionally no public or admin HTTP endpoint for this operation.
 */
export function startDurablePreviewRepairPump(): void {
  if (started || process.env.NEXT_PHASE === 'phase-production-build') return;
  started = true;
  startupTimer = setTimeout(() => {
    startupTimer = undefined;
    void runDurablePreviewRepairOnce(undefined, { retryFailed: true }).catch(() => undefined);
  }, 1_000);
  startupTimer.unref?.();
  repairInterval = setInterval(() => {
    // A later sweep retries stale pending records. Recent terminal failures
    // were already given one recovery attempt at startup, so they do not turn
    // into a five-minute source-read loop.
    void runDurablePreviewRepairOnce().catch(() => undefined);
  }, repairIntervalMs);
  repairInterval.unref?.();
}

export function stopDurablePreviewRepairPumpForTests(): void {
  if (startupTimer) clearTimeout(startupTimer);
  if (repairInterval) clearInterval(repairInterval);
  startupTimer = undefined;
  repairInterval = undefined;
  started = false;
  activeRepair = undefined;
}

/**
 * Requeues retained shared cards after safely renewing their viewer-bound
 * streams. Exported for focused tests; production invokes it only through the
 * process-local startup pump above.
 */
export async function runDurablePreviewRepairOnce(
  dependencies?: DurablePreviewRepairDependencies,
  options?: { retryFailed?: boolean },
): Promise<void> {
  if (activeRepair) return activeRepair;
  const resolvedDependencies = dependencies ?? productionDependencies();
  let current: Promise<void>;
  current = repairStoredSharedPreviews(resolvedDependencies, options)
    .catch(() => {
      // Do not disclose a viewer, stream ID, source, or eVault endpoint in
      // logs. A later process start still retries every retained card.
      reportOperationalEvent({ category: 'video_preview', code: 'durable_preview_repair_failed' });
    })
    .finally(() => {
      if (activeRepair === current) activeRepair = undefined;
    });
  activeRepair = current;
  return current;
}

async function repairStoredSharedPreviews(
  dependencies: DurablePreviewRepairDependencies,
  options?: { retryFailed?: boolean },
): Promise<void> {
  const stored = await dependencies.listStoredJobs();
  for (const summary of stored) {
    try {
      const job = await dependencies.loadJob(summary.ownerEName);
      if (
        !job ||
        job.ownerEName !== summary.ownerEName ||
        job.ownerEVaultUri !== summary.ownerEVaultUri
      )
        continue;

      const retainedItems: Array<{ streamIds: readonly string[] }> = [];
      for (const item of job.items) {
        const streamId = firstRetainedSharedStream(item);
        if (!streamId) continue;
        retainedItems.push({ streamIds: [streamId] });
      }
      if (retainedItems.length > 0) {
        await dependencies.scheduleDurableLibraryBackfill(
          { eName: job.ownerEName },
          retainedItems,
          options,
        );
      }
    } catch {
      // A corrupt or unavailable historical job cannot block a different
      // viewer's retained cards. The next startup sweep will try it again.
    }
  }
}

function firstRetainedSharedStream(item: MeshengerVideo): string | undefined {
  if (item.accessScope !== 'shared') return undefined;
  const streamId = item.streamIds[0];
  return typeof streamId === 'string' && streamId.length > 0 ? streamId : undefined;
}

function productionDependencies(): DurablePreviewRepairDependencies {
  const store = getInventoryJobStore();
  const previews = getVideoPreviewService();
  return {
    listStoredJobs: async () => (store.listStored ? store.listStored() : []),
    loadJob: (ownerEName) => store.getByOwner(ownerEName),
    scheduleDurableLibraryBackfill: (viewer, items, options) =>
      previews.scheduleDurableLibraryBackfill(viewer, items, options),
  };
}
