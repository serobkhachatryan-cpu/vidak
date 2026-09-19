import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { setOperationalLogSinkForTests } from '../ops-observability';
import { completeInventory } from '../video-space/completeness';
import { emptySourceCounts } from '../video-space/discovery';
import type { InventoryJobRecord } from '../video-space/job-store';
import { runDurablePreviewRepairOnce } from './durable-repair-pump';

function job(overrides: Partial<InventoryJobRecord> = {}): InventoryJobRecord {
  return {
    id: 'job-1',
    ownerEName: '@viewer.w3id',
    ownerEVaultUri: 'https://vault.example',
    status: 'complete',
    completeness: completeInventory,
    ledger: {},
    items: [],
    conversations: [],
    messages: [],
    sourceCounts: emptySourceCounts(),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('durable preview repair pump', () => {
  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
  });

  it('queues only retained shared streams for just-in-time repair', async () => {
    const retained = job({
      items: [
        { id: 'shared', accessScope: 'shared', streamIds: ['expired-shared'] },
        { id: 'personal', accessScope: 'personal', streamIds: ['personal-stream'] },
        { id: 'empty', accessScope: 'shared', streamIds: [] },
      ] as InventoryJobRecord['items'],
    });
    const scheduleDurableLibraryBackfill = vi.fn().mockResolvedValue(undefined);

    await runDurablePreviewRepairOnce(
      {
        listStoredJobs: async () => [
          { ownerEName: retained.ownerEName, ownerEVaultUri: retained.ownerEVaultUri },
        ],
        loadJob: async () => retained,
        scheduleDurableLibraryBackfill,
      },
      { retryFailed: true },
    );

    expect(scheduleDurableLibraryBackfill).toHaveBeenCalledWith(
      { eName: '@viewer.w3id' },
      [{ streamIds: ['expired-shared'] }],
      { retryFailed: true },
    );
  });

  it('passes every retained shared stream to the durable queue', async () => {
    const retained = job({
      items: [
        { id: 'bad', accessScope: 'shared', streamIds: ['bad-stream'] },
        { id: 'good', accessScope: 'shared', streamIds: ['good-stream'] },
      ] as InventoryJobRecord['items'],
    });
    const scheduleDurableLibraryBackfill = vi.fn().mockResolvedValue(undefined);

    await runDurablePreviewRepairOnce({
      listStoredJobs: async () => [
        { ownerEName: retained.ownerEName, ownerEVaultUri: retained.ownerEVaultUri },
      ],
      loadJob: async () => retained,
      scheduleDurableLibraryBackfill,
    });

    expect(scheduleDurableLibraryBackfill).toHaveBeenCalledWith(
      { eName: '@viewer.w3id' },
      [{ streamIds: ['bad-stream'] }, { streamIds: ['good-stream'] }],
      undefined,
    );
  });

  it('does not queue a job whose persisted eVault binding changed', async () => {
    const summary = job();
    const mismatched = job({ ownerEVaultUri: 'https://other-vault.example' });
    const scheduleDurableLibraryBackfill = vi.fn();

    await runDurablePreviewRepairOnce({
      listStoredJobs: async () => [
        { ownerEName: summary.ownerEName, ownerEVaultUri: summary.ownerEVaultUri },
      ],
      loadJob: async () => mismatched,
      scheduleDurableLibraryBackfill,
    });

    expect(scheduleDurableLibraryBackfill).not.toHaveBeenCalled();
  });

  it('reports that a completed sweep queued retained shared cards without logging identities', async () => {
    const events: Array<{
      code?: string;
      repair?: { queuedSharedCards?: number; storedJobs?: number };
    }> = [];
    setOperationalLogSinkForTests((line) =>
      events.push(
        JSON.parse(line) as {
          code?: string;
          repair?: { queuedSharedCards?: number; storedJobs?: number };
        },
      ),
    );
    const retained = job({
      items: [
        { id: 'shared', accessScope: 'shared', streamIds: ['expired-shared'] },
      ] as InventoryJobRecord['items'],
    });

    await runDurablePreviewRepairOnce({
      listStoredJobs: async () => [
        { ownerEName: retained.ownerEName, ownerEVaultUri: retained.ownerEVaultUri },
      ],
      loadJob: async () => retained,
      scheduleDurableLibraryBackfill: async () => undefined,
    });

    expect(events.map((event) => event.code)).toEqual(
      expect.arrayContaining([
        'durable_preview_repair_sweep',
        'durable_preview_repair_sweep_completed',
        'durable_preview_repair_queued',
      ]),
    );
    expect(events.find((event) => event.code === 'durable_preview_repair_sweep')?.repair).toEqual({
      storedJobs: 1,
      loadedJobs: 1,
      queuedSharedCards: 1,
      skippedJobs: 0,
    });
    expect(JSON.stringify(events)).not.toContain('@viewer.w3id');
    expect(JSON.stringify(events)).not.toContain('expired-shared');
  });

  it('reports a failed job load without blocking the rest of a sweep', async () => {
    const events: Array<{ code?: string }> = [];
    setOperationalLogSinkForTests((line) => events.push(JSON.parse(line) as { code?: string }));
    const retained = job();

    await runDurablePreviewRepairOnce({
      listStoredJobs: async () => [
        { ownerEName: retained.ownerEName, ownerEVaultUri: retained.ownerEVaultUri },
      ],
      loadJob: async () => {
        throw new Error('source credentials must not be logged');
      },
      scheduleDurableLibraryBackfill: async () => undefined,
    });

    expect(events.map((event) => event.code)).toEqual(
      expect.arrayContaining([
        'durable_preview_job_load_failed',
        'durable_preview_repair_no_shared_cards',
      ]),
    );
    expect(JSON.stringify(events)).not.toContain('source credentials');
  });

  it('reports an in-process queue failure without exposing the retained stream', async () => {
    const events: Array<{ code?: string }> = [];
    setOperationalLogSinkForTests((line) => events.push(JSON.parse(line) as { code?: string }));
    const retained = job({
      items: [
        { id: 'shared', accessScope: 'shared', streamIds: ['retained-stream'] },
      ] as InventoryJobRecord['items'],
    });

    await runDurablePreviewRepairOnce({
      listStoredJobs: async () => [
        { ownerEName: retained.ownerEName, ownerEVaultUri: retained.ownerEVaultUri },
      ],
      loadJob: async () => retained,
      scheduleDurableLibraryBackfill: async () => {
        throw new Error('queue failure must not be logged');
      },
    });

    expect(events.map((event) => event.code)).toContain('durable_preview_queue_schedule_failed');
    expect(JSON.stringify(events)).not.toContain('queue failure');
    expect(JSON.stringify(events)).not.toContain('retained-stream');
  });
});
