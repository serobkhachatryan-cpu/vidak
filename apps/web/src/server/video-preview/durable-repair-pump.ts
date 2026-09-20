import 'server-only';

import type { AuthUser } from '@w3ds/auth';
import type { MeshengerVideo } from '../meshenger-video-library';
import { reportDurablePreviewRepairSweep, reportOperationalEvent } from '../ops-observability';
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
let repairInterval: ReturnType<typeof setInterval> | undefined;

type DurablePreviewRepairSweep = {
  storedJobs: number;
  loadedJobs: number;
  queuedSharedCards: number;
  skippedJobs: number;
};

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
  // This used to wait behind an unreferenced startup timer. In a managed
  // Next runtime that made the only repair sweep easy to lose before it had
  // performed its first durable database read. Start it now, without awaiting
  // it in instrumentation: the first await is the bounded local job lookup,
  // and the actual source reads remain in the single-file background queue.
  reportOperationalEvent({
    category: 'video_preview',
    code: 'durable_preview_repair_pump_started',
  });
  // A restart must not turn every terminal preview failure into an immediate
  // eVault retry storm. Failed records already have a durable backoff in the
  // preview service; stale pending records still resume here, ahead of a
  // source that has recently proved unavailable.
  launchDurablePreviewRepair();
  repairInterval = setInterval(() => {
    // A later sweep retries stale pending records and failures only after the
    // preview service's durable failure backoff. This keeps an unavailable
    // eVault from monopolizing the one-worker recovery lane.
    launchDurablePreviewRepair();
  }, repairIntervalMs);
  repairInterval.unref?.();
}

export function stopDurablePreviewRepairPumpForTests(): void {
  if (repairInterval) clearInterval(repairInterval);
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
  let current: Promise<void>;
  // Construct production dependencies inside the guarded chain. A malformed
  // runtime configuration used to reject before the catch below and then get
  // silently discarded by the fire-and-forget pump launcher.
  current = Promise.resolve()
    .then(() => repairStoredSharedPreviews(dependencies ?? productionDependencies(), options))
    .then((sweep) => {
      emitDurablePreviewRepairSweep(sweep);
    })
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
): Promise<DurablePreviewRepairSweep> {
  const stored = await dependencies.listStoredJobs();
  const sweep: DurablePreviewRepairSweep = {
    storedJobs: stored.length,
    loadedJobs: 0,
    queuedSharedCards: 0,
    skippedJobs: 0,
  };
  for (const summary of stored) {
    let job: InventoryJobRecord | undefined;
    try {
      job = await dependencies.loadJob(summary.ownerEName);
    } catch {
      // A corrupt or unavailable historical job cannot block a different
      // viewer's retained cards. The next startup sweep will try it again.
      sweep.skippedJobs += 1;
      reportOperationalEvent({
        category: 'video_preview',
        code: 'durable_preview_job_load_failed',
      });
      continue;
    }
    if (
      !job ||
      job.ownerEName !== summary.ownerEName ||
      job.ownerEVaultUri !== summary.ownerEVaultUri
    ) {
      sweep.skippedJobs += 1;
      continue;
    }
    sweep.loadedJobs += 1;

    const retainedItems: Array<{ streamIds: readonly string[] }> = [];
    for (const item of job.items) {
      const streamId = firstRetainedSharedStream(item);
      if (!streamId) continue;
      retainedItems.push({ streamIds: [streamId] });
    }
    if (retainedItems.length === 0) continue;
    try {
      await dependencies.scheduleDurableLibraryBackfill(
        { eName: job.ownerEName },
        retainedItems,
        options,
      );
      sweep.queuedSharedCards += retainedItems.length;
    } catch {
      // If the in-process preview service cannot accept this batch, retain a
      // safe aggregate signal instead of making the next job invisible.
      sweep.skippedJobs += 1;
      reportOperationalEvent({
        category: 'video_preview',
        code: 'durable_preview_queue_schedule_failed',
      });
    }
  }
  return sweep;
}

function launchDurablePreviewRepair(options?: { retryFailed?: boolean }): void {
  void runDurablePreviewRepairOnce(undefined, options).catch(() => undefined);
}

/**
 * Emits a fixed set of aggregate-only signals. Counts help distinguish a
 * missing hook from an empty or rejected durable inventory, while avoiding
 * eNames, grants, File URIs, source URLs, and error text.
 */
function emitDurablePreviewRepairSweep(sweep: DurablePreviewRepairSweep): void {
  reportDurablePreviewRepairSweep(sweep);
  reportOperationalEvent({
    category: 'video_preview',
    code: 'durable_preview_repair_sweep_completed',
  });
  if (sweep.storedJobs === 0) {
    reportOperationalEvent({
      category: 'video_preview',
      code: 'durable_preview_repair_no_stored_jobs',
    });
    return;
  }
  if (sweep.queuedSharedCards === 0) {
    reportOperationalEvent({
      category: 'video_preview',
      code: 'durable_preview_repair_no_shared_cards',
    });
    return;
  }
  reportOperationalEvent({ category: 'video_preview', code: 'durable_preview_repair_queued' });
  if (sweep.skippedJobs > 0) {
    reportOperationalEvent({
      category: 'video_preview',
      code: 'durable_preview_repair_jobs_skipped',
    });
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
