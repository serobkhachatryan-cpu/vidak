import { describe, expect, it } from 'vitest';
import { createMemoryInventoryJobStore } from './job-store';
import { type DeferredWork, drainFairVaultQueue } from './work-queue';

type Work = DeferredWork & {
  type: string;
  vaultKey: string;
  after: string | null;
  id: string;
};

describe('durable inventory checkpoints', () => {
  it('resumes the exact unfinished vault cursor instead of restarting that scan', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const unfinished: Work = {
      type: 'group-files',
      vaultKey: '@group-b.w3id',
      after: 'cursor-file-2',
      attempts: 1,
      notBefore: 0,
      id: 'file-page',
    };
    await store.enqueueTask({
      jobId: job.id,
      taskKey: 'group-files\u0000@group-b.w3id\u0000file\u0000\u0000cursor-file-2',
      kind: 'group-files',
      vaultKey: '@group-b.w3id',
      ontologyId: 'file',
      cursorAfter: 'cursor-file-2',
      attempts: 1,
      notBefore: 0,
      priority: 40,
      payload: unfinished as unknown as Record<string, unknown>,
    });
    await store.saveJob({
      ...job,
      status: 'running',
      ledger: { queue: [unfinished] },
    });

    const restarted = createMemoryInventoryJobStore();
    // Simulate process restart with a copied checkpoint.
    const copied = await store.getByOwner('@viewer.w3id');
    expect(copied?.ledger.queue).toEqual([unfinished]);
    const open = await store.loadOpenTasks(job.id);
    expect(open).toHaveLength(1);
    expect(open[0]?.cursorAfter).toBe('cursor-file-2');
    expect(open[0]?.attempts).toBe(1);
    expect(restarted).toBeDefined();
  });

  it('pages independent ontologies fairly so one vault cannot starve another', async () => {
    const log: string[] = [];
    const queue: Work[] = [
      { type: 'messages', vaultKey: '@vault-a.w3id', after: 'm1', attempts: 0, id: 'a-msg' },
      { type: 'messages', vaultKey: '@vault-a.w3id', after: 'm2', attempts: 0, id: 'a-msg-2' },
      { type: 'group-open', vaultKey: '@vault-b.w3id', after: null, attempts: 0, id: 'b-open' },
      { type: 'group-files', vaultKey: '@vault-b.w3id', after: null, attempts: 0, id: 'b-files' },
    ];
    await drainFairVaultQueue(
      queue,
      async (item) => {
        log.push(`${item.vaultKey}:${item.type}`);
        if (item.type === 'messages' && item.after === 'm1') {
          queue.push({
            type: 'messages',
            vaultKey: '@vault-a.w3id',
            after: 'm3',
            attempts: 0,
            id: 'a-msg-3',
          });
        }
      },
      {
        vaultKey: (item) => item.vaultKey,
        priority: (item) =>
          item.type === 'group-open' ? 10 : item.type === 'group-files' ? 40 : 60,
        maxVaultsPerWave: 8,
      },
    );
    expect(log[0]).toBe('@vault-a.w3id:messages');
    expect(log).toContain('@vault-b.w3id:group-open');
    expect(log.indexOf('@vault-b.w3id:group-open')).toBeLessThan(
      log.lastIndexOf('@vault-a.w3id:messages'),
    );
    expect(log).toContain('@vault-b.w3id:group-files');
  });

  it('keeps Retry-After on the same cursor and lets other vaults continue', async () => {
    let now = 1_000;
    const seen: string[] = [];
    const queue: Work[] = [
      {
        type: 'messages',
        vaultKey: '@limited.w3id',
        after: 'stay-here',
        attempts: 0,
        id: 'limited',
      },
      { type: 'group-open', vaultKey: '@other.w3id', after: null, attempts: 0, id: 'other' },
    ];
    const gates = new Map<string, number>();
    await drainFairVaultQueue(
      queue,
      async (item) => {
        seen.push(`${item.vaultKey}:${item.after ?? 'open'}:${item.attempts}`);
        if (item.vaultKey === '@limited.w3id' && item.attempts === 0) {
          item.attempts = 1;
          item.notBefore = now + 5_000;
          gates.set(item.vaultKey, item.notBefore);
          queue.push(item);
          return;
        }
      },
      {
        vaultKey: (item) => item.vaultKey,
        priority: (item) => (item.type === 'group-open' ? 10 : 60),
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        maxWaitMs: 50,
        vaultNotBefore: (vault) => gates.get(vault) ?? 0,
      },
    );
    expect(seen).toContain('@limited.w3id:stay-here:0');
    expect(seen).toContain('@other.w3id:open:0');
    expect(seen).toContain('@limited.w3id:stay-here:1');
    expect(seen.indexOf('@other.w3id:open:0')).toBeLessThan(
      seen.indexOf('@limited.w3id:stay-here:1'),
    );
  });

  it('claims one drain lock so a second worker observes instead of reseeding', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    expect(await store.tryClaimDrain(job.id, 1_000)).toBe(true);
    expect(await store.tryClaimDrain(job.id, 1_000)).toBe(false);
    await store.releaseDrain(job.id);
    expect(await store.tryClaimDrain(job.id, 2_000)).toBe(true);
  });
});
