import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { getW3dsDatabase } from '../db/client';
import {
  type VideoSpaceInventoryJobStatus,
  type VideoSpaceInventoryTaskStatus,
  videoSpaceInventoryItems,
  videoSpaceInventoryJobs,
  videoSpaceInventoryTasks,
  videoSpaceVaultGates,
} from '../db/schema';
import type {
  MeshengerConversation,
  MeshengerMessage,
  MeshengerVideo,
} from '../meshenger-video-library';
import type { InventoryCompleteness } from './completeness';
import {
  completeInventory,
  emptyInventoryCoverage,
  emptyInventoryMediaCounts,
} from './completeness';
import type { InventorySourceCounts } from './discovery';
import { emptySourceCounts } from './discovery';

export type InventoryTaskKind =
  | 'owned-source'
  | 'chats'
  | 'messages'
  | 'group-open'
  | 'group-chats'
  | 'group-messages'
  | 'group-history'
  | 'group-manifests'
  | 'group-calls'
  | 'group-files'
  | 'direct-open'
  | 'direct-messages'
  | 'direct-chats'
  | 'direct-history'
  | 'direct-calls'
  | 'author-messages'
  | 'resolve-media';

export interface PersistedInventoryTask {
  id: string;
  jobId: string;
  taskKey: string;
  kind: InventoryTaskKind;
  vaultKey: string;
  ontologyId?: string;
  cursorAfter: string | null;
  attempts: number;
  notBefore: number;
  status: VideoSpaceInventoryTaskStatus;
  priority: number;
  payload: Record<string, unknown>;
  lockedUntil?: number;
}

export interface InventoryJobRecord {
  id: string;
  ownerEName: string;
  ownerEVaultUri: string;
  status: VideoSpaceInventoryJobStatus;
  completeness: InventoryCompleteness;
  ledger: Record<string, unknown>;
  items: MeshengerVideo[];
  conversations: MeshengerConversation[];
  messages: MeshengerMessage[];
  sourceCounts: InventorySourceCounts;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface InventoryJobStore {
  getByOwner(ownerEName: string): Promise<InventoryJobRecord | undefined>;
  listRunning(): Promise<InventoryJobRecord[]>;
  createJob(input: {
    ownerEName: string;
    ownerEVaultUri: string;
    completeness?: InventoryCompleteness;
  }): Promise<InventoryJobRecord>;
  replaceJob(input: {
    ownerEName: string;
    ownerEVaultUri: string;
    completeness?: InventoryCompleteness;
  }): Promise<InventoryJobRecord>;
  saveJob(job: InventoryJobRecord): Promise<void>;
  enqueueTask(
    task: Omit<PersistedInventoryTask, 'id' | 'status'> & {
      status?: VideoSpaceInventoryTaskStatus;
    },
  ): Promise<boolean>;
  loadOpenTasks(jobId: string): Promise<PersistedInventoryTask[]>;
  saveTask(task: PersistedInventoryTask): Promise<void>;
  replaceOpenTasks(jobId: string, tasks: PersistedInventoryTask[]): Promise<void>;
  recoverStaleLocks(now: number, staleMs?: number): Promise<void>;
  vaultNotBefore(vaultKey: string, now: number): Promise<number>;
  setVaultGate(vaultKey: string, notBefore: number, inflightUntil?: number): Promise<void>;
  clearVaultInflight(vaultKey: string): Promise<void>;
  tryClaimDrain(jobId: string, now: number, ttlMs?: number): Promise<boolean>;
  heartbeatDrain(jobId: string, now: number, ttlMs?: number): Promise<void>;
  releaseDrain(jobId: string): Promise<void>;
}

const drainLockTtlMs = 45_000;

export function inventoryDrainGateKey(jobId: string): string {
  return `inventory-drain:${jobId}`;
}

const staleLockMs = 60_000;

function emptyJob(
  ownerEName: string,
  ownerEVaultUri: string,
  completeness?: InventoryCompleteness,
): InventoryJobRecord {
  const now = Date.now();
  return {
    id: randomUUID(),
    ownerEName,
    ownerEVaultUri,
    status: 'running',
    completeness: completeness ?? {
      ...completeInventory,
      complete: false,
      coverage: { ...emptyInventoryCoverage },
      media: { ...emptyInventoryMediaCounts, unresolved: {} },
    },
    ledger: {},
    items: [],
    conversations: [],
    messages: [],
    sourceCounts: emptySourceCounts(),
    createdAt: now,
    updatedAt: now,
  };
}

function cloneJob(job: InventoryJobRecord): InventoryJobRecord {
  return {
    ...job,
    completeness: {
      ...job.completeness,
      ...(job.completeness.coverage ? { coverage: { ...job.completeness.coverage } } : {}),
      ...(job.completeness.media
        ? {
            media: {
              ...job.completeness.media,
              unresolved: { ...job.completeness.media.unresolved },
            },
          }
        : {}),
    },
    ledger: structuredClone(job.ledger),
    items: [...job.items],
    conversations: [...job.conversations],
    messages: [...job.messages],
    sourceCounts: { ...job.sourceCounts },
  };
}

function cloneTask(task: PersistedInventoryTask): PersistedInventoryTask {
  return { ...task, payload: { ...task.payload } };
}

export function createMemoryInventoryJobStore(): InventoryJobStore {
  const jobs = new Map<string, InventoryJobRecord>();
  const tasks = new Map<string, PersistedInventoryTask[]>();
  const gates = new Map<string, { notBefore: number; inflightUntil?: number }>();

  return {
    async getByOwner(ownerEName) {
      const job = jobs.get(ownerEName);
      return job ? cloneJob(job) : undefined;
    },
    async listRunning() {
      return [...jobs.values()].filter((job) => job.status === 'running').map(cloneJob);
    },
    async createJob(input) {
      const existing = jobs.get(input.ownerEName);
      if (existing) return cloneJob(existing);
      const job = emptyJob(input.ownerEName, input.ownerEVaultUri, input.completeness);
      jobs.set(input.ownerEName, job);
      tasks.set(job.id, []);
      return cloneJob(job);
    },
    async replaceJob(input) {
      const previous = jobs.get(input.ownerEName);
      if (previous) tasks.delete(previous.id);
      const job = emptyJob(input.ownerEName, input.ownerEVaultUri, input.completeness);
      jobs.set(input.ownerEName, job);
      tasks.set(job.id, []);
      return cloneJob(job);
    },
    async saveJob(job) {
      jobs.set(job.ownerEName, cloneJob(job));
    },
    async enqueueTask(input) {
      const list = tasks.get(input.jobId);
      if (!list) return false;
      if (list.some((task) => task.taskKey === input.taskKey)) return false;
      list.push(
        cloneTask({
          ...input,
          id: randomUUID(),
          status: input.status ?? 'pending',
          payload: { ...input.payload },
        }),
      );
      return true;
    },
    async loadOpenTasks(jobId) {
      return (tasks.get(jobId) ?? [])
        .filter((task) => task.status === 'pending' || task.status === 'in_progress')
        .map(cloneTask);
    },
    async saveTask(task) {
      const list = tasks.get(task.jobId);
      if (!list) return;
      const index = list.findIndex((item) => item.taskKey === task.taskKey);
      if (index === -1) list.push(cloneTask(task));
      else list[index] = cloneTask(task);
    },
    async replaceOpenTasks(jobId, next) {
      tasks.set(jobId, next.map(cloneTask));
    },
    async recoverStaleLocks(now, staleMs = staleLockMs) {
      for (const list of tasks.values()) {
        for (const task of list) {
          if (task.status !== 'in_progress') continue;
          if ((task.lockedUntil ?? 0) > now && now - (task.lockedUntil ?? 0) < staleMs) continue;
          if ((task.lockedUntil ?? 0) > now) continue;
          task.status = 'pending';
          delete task.lockedUntil;
        }
      }
      for (const [vault, gate] of gates) {
        if ((gate.inflightUntil ?? 0) <= now) {
          gates.set(vault, { notBefore: gate.notBefore });
        }
      }
    },
    async vaultNotBefore(vaultKey, now) {
      const gate = gates.get(vaultKey);
      if (!gate) return 0;
      if ((gate.inflightUntil ?? 0) > now) return Number.POSITIVE_INFINITY;
      return gate.notBefore;
    },
    async setVaultGate(vaultKey, notBefore, inflightUntil) {
      const previous = gates.get(vaultKey);
      gates.set(vaultKey, {
        notBefore: Math.max(previous?.notBefore ?? 0, notBefore),
        ...(inflightUntil !== undefined ? { inflightUntil } : {}),
      });
    },
    async clearVaultInflight(vaultKey) {
      const previous = gates.get(vaultKey);
      if (!previous) return;
      gates.set(vaultKey, { notBefore: previous.notBefore });
    },
    async tryClaimDrain(jobId, now, ttlMs = drainLockTtlMs) {
      const key = inventoryDrainGateKey(jobId);
      const gate = gates.get(key);
      if ((gate?.inflightUntil ?? 0) > now) return false;
      gates.set(key, { notBefore: gate?.notBefore ?? 0, inflightUntil: now + ttlMs });
      return true;
    },
    async heartbeatDrain(jobId, now, ttlMs = drainLockTtlMs) {
      const key = inventoryDrainGateKey(jobId);
      const gate = gates.get(key);
      gates.set(key, { notBefore: gate?.notBefore ?? 0, inflightUntil: now + ttlMs });
    },
    async releaseDrain(jobId) {
      await this.clearVaultInflight(inventoryDrainGateKey(jobId));
    },
  };
}

function asJobRecord(
  row: typeof videoSpaceInventoryJobs.$inferSelect,
  items: MeshengerVideo[],
  conversations: MeshengerConversation[],
  messages: MeshengerMessage[],
  sourceCounts: InventorySourceCounts,
): InventoryJobRecord {
  const ledger = (row.ledger ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    ownerEName: row.ownerEName,
    ownerEVaultUri: row.ownerEVaultUri,
    status: row.status,
    completeness: row.completeness as unknown as InventoryCompleteness,
    ledger,
    items,
    conversations,
    messages,
    sourceCounts,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    ...(row.completedAt ? { completedAt: row.completedAt.getTime() } : {}),
  };
}

function taskFromRow(row: typeof videoSpaceInventoryTasks.$inferSelect): PersistedInventoryTask {
  return {
    id: row.id,
    jobId: row.jobId,
    taskKey: row.taskKey,
    kind: row.kind as InventoryTaskKind,
    vaultKey: row.vaultKey,
    ...(row.ontologyId ? { ontologyId: row.ontologyId } : {}),
    cursorAfter: row.cursorAfter,
    attempts: row.attempts,
    notBefore: row.notBefore.getTime(),
    status: row.status,
    priority: row.priority,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    ...(row.lockedUntil ? { lockedUntil: row.lockedUntil.getTime() } : {}),
  };
}

export function createDrizzleInventoryJobStore(): InventoryJobStore {
  const db = () => getW3dsDatabase();

  async function loadJobExtras(jobId: string, ledger: Record<string, unknown>) {
    const itemRows = await db()
      .select()
      .from(videoSpaceInventoryItems)
      .where(eq(videoSpaceInventoryItems.jobId, jobId));
    const items = itemRows
      .map((row) => row.card as unknown as MeshengerVideo)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return {
      items,
      conversations: Array.isArray(ledger.conversations)
        ? (ledger.conversations as MeshengerConversation[])
        : [],
      messages: Array.isArray(ledger.messages) ? (ledger.messages as MeshengerMessage[]) : [],
      sourceCounts:
        ledger.sourceCounts && typeof ledger.sourceCounts === 'object'
          ? (ledger.sourceCounts as InventorySourceCounts)
          : emptySourceCounts(),
    };
  }

  return {
    async getByOwner(ownerEName) {
      const [row] = await db()
        .select()
        .from(videoSpaceInventoryJobs)
        .where(eq(videoSpaceInventoryJobs.ownerEName, ownerEName))
        .limit(1);
      if (!row) return undefined;
      const extras = await loadJobExtras(row.id, row.ledger as Record<string, unknown>);
      return asJobRecord(
        row,
        extras.items,
        extras.conversations,
        extras.messages,
        extras.sourceCounts,
      );
    },
    async listRunning() {
      const rows = await db()
        .select()
        .from(videoSpaceInventoryJobs)
        .where(eq(videoSpaceInventoryJobs.status, 'running'));
      const jobs: InventoryJobRecord[] = [];
      for (const row of rows) {
        const extras = await loadJobExtras(row.id, row.ledger as Record<string, unknown>);
        jobs.push(
          asJobRecord(
            row,
            extras.items,
            extras.conversations,
            extras.messages,
            extras.sourceCounts,
          ),
        );
      }
      return jobs;
    },
    async createJob(input) {
      const existing = await this.getByOwner(input.ownerEName);
      if (existing) return existing;
      const job = emptyJob(input.ownerEName, input.ownerEVaultUri, input.completeness);
      await db()
        .insert(videoSpaceInventoryJobs)
        .values({
          id: job.id,
          ownerEName: job.ownerEName,
          ownerEVaultUri: job.ownerEVaultUri,
          status: job.status,
          completeness: job.completeness as unknown as Record<string, unknown>,
          mediaCounts: (job.completeness.media ?? emptyInventoryMediaCounts) as unknown as Record<
            string,
            unknown
          >,
          ledger: {
            ...job.ledger,
            conversations: [],
            messages: [],
            sourceCounts: job.sourceCounts,
          },
          createdAt: new Date(job.createdAt),
          updatedAt: new Date(job.updatedAt),
        });
      return job;
    },
    async replaceJob(input) {
      const existing = await this.getByOwner(input.ownerEName);
      if (existing) {
        await db()
          .delete(videoSpaceInventoryJobs)
          .where(eq(videoSpaceInventoryJobs.id, existing.id));
      }
      return this.createJob(input);
    },
    async saveJob(job) {
      const now = new Date();
      await db()
        .update(videoSpaceInventoryJobs)
        .set({
          status: job.status,
          completeness: job.completeness as unknown as Record<string, unknown>,
          mediaCounts: (job.completeness.media ?? emptyInventoryMediaCounts) as unknown as Record<
            string,
            unknown
          >,
          ledger: {
            ...job.ledger,
            conversations: job.conversations,
            messages: job.messages,
            sourceCounts: job.sourceCounts,
          },
          updatedAt: now,
          completedAt: job.completedAt ? new Date(job.completedAt) : null,
          ownerEVaultUri: job.ownerEVaultUri,
        })
        .where(eq(videoSpaceInventoryJobs.id, job.id));
      for (const item of job.items) {
        await db()
          .insert(videoSpaceInventoryItems)
          .values({
            id: `${job.id}:${item.id}`,
            jobId: job.id,
            itemKey: item.id,
            card: item as unknown as Record<string, unknown>,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [videoSpaceInventoryItems.jobId, videoSpaceInventoryItems.itemKey],
            set: { card: item as unknown as Record<string, unknown> },
          });
      }
    },
    async enqueueTask(input) {
      try {
        await db()
          .insert(videoSpaceInventoryTasks)
          .values({
            id: randomUUID(),
            jobId: input.jobId,
            taskKey: input.taskKey,
            kind: input.kind,
            vaultKey: input.vaultKey,
            ontologyId: input.ontologyId,
            cursorAfter: input.cursorAfter,
            attempts: input.attempts,
            notBefore: new Date(input.notBefore),
            status: input.status ?? 'pending',
            priority: input.priority,
            payload: input.payload,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        return true;
      } catch {
        return false;
      }
    },
    async loadOpenTasks(jobId) {
      const rows = await db()
        .select()
        .from(videoSpaceInventoryTasks)
        .where(
          and(
            eq(videoSpaceInventoryTasks.jobId, jobId),
            or(
              eq(videoSpaceInventoryTasks.status, 'pending'),
              eq(videoSpaceInventoryTasks.status, 'in_progress'),
            ),
          ),
        );
      return rows.map(taskFromRow);
    },
    async saveTask(task) {
      await db()
        .insert(videoSpaceInventoryTasks)
        .values({
          id: task.id,
          jobId: task.jobId,
          taskKey: task.taskKey,
          kind: task.kind,
          vaultKey: task.vaultKey,
          ontologyId: task.ontologyId,
          cursorAfter: task.cursorAfter,
          attempts: task.attempts,
          notBefore: new Date(task.notBefore),
          status: task.status,
          priority: task.priority,
          payload: task.payload,
          lockedUntil: task.lockedUntil ? new Date(task.lockedUntil) : null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [videoSpaceInventoryTasks.jobId, videoSpaceInventoryTasks.taskKey],
          set: {
            cursorAfter: task.cursorAfter,
            attempts: task.attempts,
            notBefore: new Date(task.notBefore),
            status: task.status,
            priority: task.priority,
            payload: task.payload,
            lockedUntil: task.lockedUntil ? new Date(task.lockedUntil) : null,
            updatedAt: new Date(),
          },
        });
    },
    async replaceOpenTasks(jobId, next) {
      await db()
        .delete(videoSpaceInventoryTasks)
        .where(
          and(
            eq(videoSpaceInventoryTasks.jobId, jobId),
            or(
              eq(videoSpaceInventoryTasks.status, 'pending'),
              eq(videoSpaceInventoryTasks.status, 'in_progress'),
            ),
          ),
        );
      for (const task of next) await this.saveTask(task);
    },
    async recoverStaleLocks(now, stale = staleLockMs) {
      const cutoff = new Date(now - stale);
      await db()
        .update(videoSpaceInventoryTasks)
        .set({ status: 'pending', lockedUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(videoSpaceInventoryTasks.status, 'in_progress'),
            or(
              lte(videoSpaceInventoryTasks.lockedUntil, cutoff),
              isNull(videoSpaceInventoryTasks.lockedUntil),
            ),
          ),
        );
      await db()
        .update(videoSpaceVaultGates)
        .set({ inflightUntil: null, updatedAt: new Date() })
        .where(lte(videoSpaceVaultGates.inflightUntil, new Date(now)));
    },
    async vaultNotBefore(vaultKey, now) {
      const [row] = await db()
        .select()
        .from(videoSpaceVaultGates)
        .where(eq(videoSpaceVaultGates.vaultKey, vaultKey))
        .limit(1);
      if (!row) return 0;
      if (row.inflightUntil && row.inflightUntil.getTime() > now) return Number.POSITIVE_INFINITY;
      return row.notBefore.getTime();
    },
    async setVaultGate(vaultKey, notBefore, inflightUntil) {
      const now = new Date();
      await db()
        .insert(videoSpaceVaultGates)
        .values({
          vaultKey,
          notBefore: new Date(notBefore),
          inflightUntil: inflightUntil !== undefined ? new Date(inflightUntil) : null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: videoSpaceVaultGates.vaultKey,
          set: {
            notBefore: new Date(notBefore),
            inflightUntil: inflightUntil !== undefined ? new Date(inflightUntil) : null,
            updatedAt: now,
          },
        });
    },
    async clearVaultInflight(vaultKey) {
      await db()
        .update(videoSpaceVaultGates)
        .set({ inflightUntil: null, updatedAt: new Date() })
        .where(eq(videoSpaceVaultGates.vaultKey, vaultKey));
    },
    async tryClaimDrain(jobId, now, ttlMs = drainLockTtlMs) {
      const gated = await this.vaultNotBefore(inventoryDrainGateKey(jobId), now);
      if (gated === Number.POSITIVE_INFINITY) return false;
      await this.setVaultGate(inventoryDrainGateKey(jobId), 0, now + ttlMs);
      return true;
    },
    async heartbeatDrain(jobId, now, ttlMs = drainLockTtlMs) {
      await this.setVaultGate(inventoryDrainGateKey(jobId), 0, now + ttlMs);
    },
    async releaseDrain(jobId) {
      await this.clearVaultInflight(inventoryDrainGateKey(jobId));
    },
  };
}

let defaultStore: InventoryJobStore | undefined;
let memoryFallback: InventoryJobStore | undefined;

export function getInventoryJobStore(): InventoryJobStore {
  if (defaultStore) return defaultStore;
  if (process.env.DATABASE_URL?.trim()) {
    try {
      defaultStore = createDrizzleInventoryJobStore();
      return defaultStore;
    } catch {
      // Tests and local scans without a migrated schema keep a memory store.
    }
  }
  memoryFallback ??= createMemoryInventoryJobStore();
  return memoryFallback;
}

export function setInventoryJobStoreForTests(store?: InventoryJobStore): void {
  defaultStore = store;
  if (!store) memoryFallback = undefined;
}
