import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

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
});
