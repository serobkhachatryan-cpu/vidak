import { describe, expect, it } from 'vitest';
import { VIDEO_SPACE_CATALOGUE_VERSION } from './catalogue-version';
import { inventoryTaskKey } from './inventory-schedule';
import { createMemoryInventoryJobStore, toPostgresJson } from './job-store';
import { type DeferredWork, drainFairVaultQueue, upsertWork } from './work-queue';

type Work = DeferredWork & {
  type: string;
  vaultKey: string;
  after: string | null;
  id: string;
};

describe('durable inventory checkpoints', () => {
  it('returns only a current exact card for its authenticated owner', async () => {
    const store = createMemoryInventoryJobStore();
    const current = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const card = {
      id: 'w3ds-file:@owner.w3id/shared-recording',
      kind: 'call-recording' as const,
      title: 'Shared recording',
      accessScope: 'shared' as const,
      visibility: 'shared-with-me' as const,
      streamIds: ['opaque-viewer-stream'],
    };
    await store.saveJob({
      ...current,
      status: 'complete',
      completeness: { ...current.completeness, complete: true, retryNeeded: false },
      ledger: { drainFinished: true, catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION },
      items: [card],
    });

    await expect(store.getItemByOwner('@viewer.w3id', card.id)).resolves.toEqual(card);
    await expect(store.getItemByOwner('@other.w3id', card.id)).resolves.toBeUndefined();

    const stale = await store.createJob({
      ownerEName: '@stale-viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...stale,
      status: 'complete',
      completeness: { ...stale.completeness, complete: true, retryNeeded: false },
      ledger: {
        drainFinished: true,
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION - 1,
      },
      items: [card],
    });
    await expect(store.getItemByOwner('@stale-viewer.w3id', card.id)).resolves.toBeUndefined();
  });

  it('pumps completed stale catalogue jobs after a media-discovery repair', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveJob({
      ...job,
      status: 'complete',
      completeness: { ...job.completeness, complete: true, retryNeeded: false },
      ledger: { drainFinished: true, catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION - 1 },
    });

    expect((await store.listRunning()).map((item) => item.id)).toEqual([job.id]);
  });

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
    expect(log[0]).toBe('@vault-b.w3id:group-open');
    expect(log).toContain('@vault-b.w3id:group-open');
    expect(log.indexOf('@vault-b.w3id:group-open')).toBeLessThan(
      log.lastIndexOf('@vault-a.w3id:messages'),
    );
    expect(log).toContain('@vault-b.w3id:group-files');
  });

  it('yields a durable remainder after the configured number of active waves', async () => {
    const queue: Work[] = [
      { type: 'messages', vaultKey: '@vault-a.w3id', after: 'first', attempts: 0, id: 'a-1' },
      { type: 'messages', vaultKey: '@vault-a.w3id', after: 'second', attempts: 0, id: 'a-2' },
      { type: 'group-open', vaultKey: '@vault-b.w3id', after: null, attempts: 0, id: 'b-1' },
    ];
    const seen: string[] = [];
    let persisted = 0;

    await drainFairVaultQueue(
      queue,
      async (item) => {
        seen.push(item.id);
      },
      {
        vaultKey: (item) => item.vaultKey,
        priority: () => 1,
        maxVaultsPerWave: 1,
        maxWaves: 1,
        persist: () => {
          persisted += 1;
        },
      },
    );

    expect(seen).toEqual(['a-1']);
    expect(queue.map((item) => item.id).sort()).toEqual(['a-2', 'b-1']);
    expect(persisted).toBe(1);
  });

  it('requeues a selected cursor when playback gates its vault before dispatch', async () => {
    const now = 1_000;
    const queue: Work[] = [
      {
        type: 'messages',
        vaultKey: '@watched.w3id',
        after: 'cursor-9',
        attempts: 2,
        id: 'watched-cursor',
      },
    ];
    let gateChecks = 0;
    let processed = 0;
    let persisted = 0;

    await drainFairVaultQueue(
      queue,
      async () => {
        processed += 1;
      },
      {
        vaultKey: (item) => item.vaultKey,
        priority: () => 1,
        now: () => now,
        maxWaves: 1,
        vaultNotBefore: () => {
          gateChecks += 1;
          // The first check fills this wave. The immediate dispatch check
          // observes the Watch reservation that arrived in between.
          return gateChecks === 1 ? 0 : now + 90_000;
        },
        persist: () => {
          persisted += 1;
        },
        workKey: (item) => item.id,
      },
    );

    expect(processed).toBe(0);
    expect(persisted).toBe(1);
    expect(queue).toEqual([
      expect.objectContaining({
        id: 'watched-cursor',
        after: 'cursor-9',
        attempts: 2,
        notBefore: now + 90_000,
      }),
    ]);
  });

  it('yields deferred durable work instead of blocking the next inventory pump', async () => {
    const now = 1_000;
    const queue: Work[] = [
      {
        type: 'group-open',
        vaultKey: '@limited.w3id',
        after: null,
        attempts: 1,
        notBefore: now + 10_000,
        id: 'delayed',
      },
    ];
    let processed = 0;
    let persisted = 0;
    let slept = 0;

    await drainFairVaultQueue(
      queue,
      async () => {
        processed += 1;
      },
      {
        vaultKey: (item) => item.vaultKey,
        priority: () => 0,
        now: () => now,
        sleep: async () => {
          slept += 1;
        },
        maxWaves: 2,
        persist: () => {
          persisted += 1;
        },
        workKey: (item) => item.id,
      },
    );

    expect(processed).toBe(0);
    expect(persisted).toBe(1);
    expect(slept).toBe(0);
    expect(queue).toEqual([expect.objectContaining({ id: 'delayed' })]);
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

  it('never lets a later retry shorten an interactive vault gate', async () => {
    const store = createMemoryInventoryJobStore();
    await store.setVaultGate('@shared.w3id', 91_000, 2_000);
    // A background retry writes an earlier eligibility time after playback
    // has reserved the source. It must preserve both gate dimensions.
    await store.setVaultGate('@shared.w3id', 3_000);

    expect(await store.vaultNotBefore('@shared.w3id', 1_000)).toBe(Number.POSITIVE_INFINITY);
    await store.clearVaultInflight('@shared.w3id');
    expect(await store.vaultNotBefore('@shared.w3id', 1_000)).toBe(91_000);
  });

  it('replaces open tasks so completed cursors are not revived on resume', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    await store.saveTask({
      id: 'old',
      jobId: job.id,
      taskKey: 'chats\u0000@viewer.w3id\u0000\u0000\u0000cursor-1',
      kind: 'chats',
      vaultKey: '@viewer.w3id',
      cursorAfter: 'cursor-1',
      attempts: 1,
      notBefore: 0,
      status: 'pending',
      priority: 30,
      payload: { type: 'chats', after: 'cursor-1', attempts: 1 },
    });
    await store.replaceOpenTasks(job.id, [
      {
        id: 'current',
        jobId: job.id,
        taskKey: 'chats\u0000@viewer.w3id\u0000\u0000\u0000cursor-2',
        kind: 'chats',
        vaultKey: '@viewer.w3id',
        cursorAfter: 'cursor-2',
        attempts: 0,
        notBefore: 0,
        status: 'pending',
        priority: 30,
        payload: { type: 'chats', after: 'cursor-2', attempts: 0 },
      },
    ]);
    const open = await store.loadOpenTasks(job.id);
    expect(open).toHaveLength(1);
    expect(open[0]?.cursorAfter).toBe('cursor-2');
    expect(open.some((task) => task.cursorAfter === 'cursor-1')).toBe(false);
  });

  it('syncs open tasks without replacing unchanged durable rows', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const existing = {
      id: 'durable-task-id',
      jobId: job.id,
      taskKey: 'chats\u0000@viewer.w3id\u0000\u0000\u0000cursor-1',
      kind: 'chats' as const,
      vaultKey: '@viewer.w3id',
      cursorAfter: 'cursor-1',
      attempts: 1,
      notBefore: 0,
      status: 'pending' as const,
      priority: 30,
      payload: { type: 'chats', after: 'cursor-1', attempts: 1 },
    };
    await store.saveTask(existing);

    const sameCheckpointTask = { ...existing, id: 'fresh-in-memory-id' };
    await store.syncOpenTasks(job.id, [existing], [sameCheckpointTask]);
    let open = await store.loadOpenTasks(job.id);
    expect(open).toEqual([expect.objectContaining({ id: 'durable-task-id' })]);

    const advancedCursor = {
      ...sameCheckpointTask,
      id: 'another-in-memory-id',
      cursorAfter: 'cursor-2',
      attempts: 2,
      payload: { type: 'chats', after: 'cursor-2', attempts: 2 },
    };
    const newTask = {
      ...existing,
      id: 'new-durable-task-id',
      taskKey: 'messages\u0000@viewer.w3id\u0000\u0000\u0000cursor-1',
      kind: 'messages' as const,
      cursorAfter: 'cursor-1',
      attempts: 0,
      priority: 60,
      payload: { type: 'messages', after: 'cursor-1', attempts: 0 },
    };
    await store.syncOpenTasks(job.id, [sameCheckpointTask], [advancedCursor, newTask]);
    open = await store.loadOpenTasks(job.id);
    expect(open).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'durable-task-id',
          taskKey: advancedCursor.taskKey,
          cursorAfter: 'cursor-2',
          attempts: 2,
        }),
        expect.objectContaining({ id: 'new-durable-task-id', taskKey: newTask.taskKey }),
      ]),
    );

    await store.syncOpenTasks(job.id, [advancedCursor, newTask], [newTask]);
    open = await store.loadOpenTasks(job.id);
    expect(open).toEqual([expect.objectContaining({ taskKey: newTask.taskKey })]);
  });

  it('keeps one queued copy when the same cursor is rate-limited three times', async () => {
    let now = 1_000;
    const keyOf = (item: Work) => `${item.type}\u0000${item.vaultKey}\u0000${item.after ?? ''}`;
    const queue: Work[] = [
      {
        type: 'messages',
        vaultKey: '@limited.w3id',
        after: 'stay-here',
        attempts: 0,
        id: 'limited',
      },
    ];
    const lengths: number[] = [];
    let hits = 0;
    await drainFairVaultQueue(
      queue,
      async (item) => {
        hits += 1;
        item.attempts += 1;
        item.notBefore = now + 5;
        upsertWork(queue, item, keyOf);
        lengths.push(queue.length);
        if (hits >= 3) queue.length = 0;
      },
      {
        vaultKey: (item) => item.vaultKey,
        priority: () => 60,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        maxWaitMs: 5,
        workKey: keyOf,
      },
    );
    expect(hits).toBe(3);
    expect(Math.max(...lengths)).toBe(1);
  });

  it('survives restart with a long Retry-After before resuming the same cursor', async () => {
    const store = createMemoryInventoryJobStore();
    const job = await store.createJob({
      ownerEName: '@viewer.w3id',
      ownerEVaultUri: 'https://vault.example',
    });
    const notBefore = Date.now() + 60_000;
    const deferred: Work = {
      type: 'messages',
      vaultKey: '@limited.w3id',
      after: 'stay-here',
      attempts: 3,
      notBefore,
      id: 'limited',
    };
    await store.enqueueTask({
      jobId: job.id,
      taskKey: 'messages\u001f@limited.w3id\u001f\u001f\u001fstay-here',
      kind: 'messages',
      vaultKey: '@limited.w3id',
      cursorAfter: 'stay-here',
      attempts: 3,
      notBefore,
      priority: 60,
      payload: deferred as unknown as Record<string, unknown>,
    });
    await store.saveJob({
      ...job,
      status: 'running',
      ledger: { queue: [deferred] },
    });

    let now = notBefore - 1;
    const seen: string[] = [];
    const queue: Work[] = [structuredClone(deferred)];
    const gates = new Map<string, number>([['@limited.w3id', notBefore]]);
    await drainFairVaultQueue(
      queue,
      async (item) => {
        seen.push(`${item.after}:${item.attempts}`);
      },
      {
        vaultKey: (item) => item.vaultKey,
        priority: () => 60,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        maxWaitMs: 5_000,
        vaultNotBefore: (vault) => gates.get(vault) ?? 0,
        workKey: (item) => inventoryTaskKey(item, item.vaultKey),
      },
    );
    expect(seen).toEqual(['stay-here:3']);
  });

  it('builds postgres-safe task keys without NUL bytes', () => {
    const task = {
      type: 'resolve-media',
      after: 'cursor-1',
      ontologyId: 'file',
      chatId: 'chat-1',
      fileUri: 'w3ds://file?id=@owner.w3id/abc',
    };
    const key = inventoryTaskKey(task, '@vault.w3id');
    const prewarmKey = inventoryTaskKey({ ...task, mode: 'prewarm' }, '@vault.w3id');
    expect(key.includes('\u0000')).toBe(false);
    expect(key.split('\u001f')).toHaveLength(6);
    expect(prewarmKey).not.toBe(key);
    expect(prewarmKey.split('\u001f')).toHaveLength(7);
  });

  it('keeps separate prewarm work for distinct shared authorization contexts', () => {
    const base = {
      type: 'resolve-media',
      mode: 'prewarm',
      fileUri: 'w3ds://file?id=@owner.w3id/shared-file',
      sourceSpaceKey: '@owner.w3id',
      sourceMetadata: { chatId: 'chat-a', sourceViewerChatGrantId: 'grant-a' },
    };
    const first = inventoryTaskKey(base, '@owner.w3id');
    const second = inventoryTaskKey(
      {
        ...base,
        sourceMetadata: { chatId: 'chat-b', sourceViewerChatGrantId: 'grant-b' },
      },
      '@owner.w3id',
    );

    expect(first).not.toBe(second);
  });

  it('selects the best ready vault before applying the short-wave cap', async () => {
    const queue: Work[] = [
      { type: 'messages', vaultKey: '@older.w3id', after: 'page-1', attempts: 0, id: 'older' },
      { type: 'group-open', vaultKey: '@newer.w3id', after: null, attempts: 0, id: 'newer' },
    ];
    const seen: string[] = [];

    await drainFairVaultQueue(
      queue,
      async (item) => {
        seen.push(item.id);
      },
      {
        vaultKey: (item) => item.vaultKey,
        priority: (item) => (item.type === 'group-open' ? 10 : 60),
        maxVaultsPerWave: 1,
        maxWaves: 1,
      },
    );

    expect(seen).toEqual(['newer']);
    expect(queue.map((item) => item.id)).toEqual(['older']);
  });

  it('clones jsonb values without NUL bytes or circular refs', () => {
    const circular: { self?: unknown; title: string } = { title: 'ok\u0000x' };
    circular.self = circular;
    const cloned = toPostgresJson(circular);
    expect(cloned.title).toBe('okx');
    expect(cloned.self).toBeUndefined();
  });
});
