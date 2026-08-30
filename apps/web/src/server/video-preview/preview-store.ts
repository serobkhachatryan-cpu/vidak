import { and, eq } from 'drizzle-orm';
import type { W3dsDatabase } from '../db/client';
import {
  type VideoPreviewSourceKind,
  type VideoPreviewStatus,
  videoPreviewAssets,
} from '../db/schema';

export interface VideoPreviewRecord {
  id: string;
  sourceKind: VideoPreviewSourceKind;
  sourceKey: string;
  storageKey?: string;
  status: VideoPreviewStatus;
  captureSeconds?: number;
  byteSize?: number;
  contentType?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVideoPreviewInput {
  id: string;
  sourceKind: VideoPreviewSourceKind;
  sourceKey: string;
  status: VideoPreviewStatus;
  storageKey?: string;
  captureSeconds?: number;
  byteSize?: number;
  contentType?: string;
}

export interface VideoPreviewStore {
  getBySource(
    sourceKind: VideoPreviewSourceKind,
    sourceKey: string,
  ): Promise<VideoPreviewRecord | undefined>;
  create(input: CreateVideoPreviewInput): Promise<VideoPreviewRecord>;
  update(
    id: string,
    patch: Partial<
      Pick<
        VideoPreviewRecord,
        'status' | 'storageKey' | 'captureSeconds' | 'byteSize' | 'contentType'
      >
    >,
  ): Promise<VideoPreviewRecord | undefined>;
}

function cloneRecord(record: VideoPreviewRecord): VideoPreviewRecord {
  return { ...record };
}

function toRecord(row: {
  id: string;
  sourceKind: VideoPreviewSourceKind;
  sourceKey: string;
  storageKey: string | null;
  status: VideoPreviewStatus;
  captureSeconds: number | null;
  byteSize: number | null;
  contentType: string | null;
  createdAt: Date;
  updatedAt: Date;
}): VideoPreviewRecord {
  return {
    id: row.id,
    sourceKind: row.sourceKind,
    sourceKey: row.sourceKey,
    ...(row.storageKey ? { storageKey: row.storageKey } : {}),
    status: row.status,
    ...(row.captureSeconds !== null ? { captureSeconds: row.captureSeconds } : {}),
    ...(row.byteSize !== null ? { byteSize: row.byteSize } : {}),
    ...(row.contentType ? { contentType: row.contentType } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** In-memory store for unit tests only. */
export class InMemoryVideoPreviewStore implements VideoPreviewStore {
  private readonly records = new Map<string, VideoPreviewRecord>();

  async getBySource(
    sourceKind: VideoPreviewSourceKind,
    sourceKey: string,
  ): Promise<VideoPreviewRecord | undefined> {
    const found = [...this.records.values()].find(
      (record) => record.sourceKind === sourceKind && record.sourceKey === sourceKey,
    );
    return found ? cloneRecord(found) : undefined;
  }

  async create(input: CreateVideoPreviewInput): Promise<VideoPreviewRecord> {
    const existing = await this.getBySource(input.sourceKind, input.sourceKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    const record: VideoPreviewRecord = {
      id: input.id,
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
      status: input.status,
      ...(input.storageKey ? { storageKey: input.storageKey } : {}),
      ...(input.captureSeconds !== undefined ? { captureSeconds: input.captureSeconds } : {}),
      ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
      ...(input.contentType ? { contentType: input.contentType } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return cloneRecord(record);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        VideoPreviewRecord,
        'status' | 'storageKey' | 'captureSeconds' | 'byteSize' | 'contentType'
      >
    >,
  ): Promise<VideoPreviewRecord | undefined> {
    const existing = this.records.get(id);
    if (!existing) return undefined;
    const next: VideoPreviewRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, next);
    return cloneRecord(next);
  }
}

export class PostgresVideoPreviewStore implements VideoPreviewStore {
  constructor(private readonly db: W3dsDatabase) {}

  async getBySource(
    sourceKind: VideoPreviewSourceKind,
    sourceKey: string,
  ): Promise<VideoPreviewRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(videoPreviewAssets)
      .where(
        and(
          eq(videoPreviewAssets.sourceKind, sourceKind),
          eq(videoPreviewAssets.sourceKey, sourceKey),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  async create(input: CreateVideoPreviewInput): Promise<VideoPreviewRecord> {
    const existing = await this.getBySource(input.sourceKind, input.sourceKey);
    if (existing) return existing;
    const now = new Date();
    const [row] = await this.db
      .insert(videoPreviewAssets)
      .values({
        id: input.id,
        sourceKind: input.sourceKind,
        sourceKey: input.sourceKey,
        status: input.status,
        storageKey: input.storageKey ?? null,
        captureSeconds: input.captureSeconds ?? null,
        byteSize: input.byteSize ?? null,
        contentType: input.contentType ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return toRecord(row);
    const raced = await this.getBySource(input.sourceKind, input.sourceKey);
    if (!raced) throw new Error('Preview record could not be created.');
    return raced;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        VideoPreviewRecord,
        'status' | 'storageKey' | 'captureSeconds' | 'byteSize' | 'contentType'
      >
    >,
  ): Promise<VideoPreviewRecord | undefined> {
    const [row] = await this.db
      .update(videoPreviewAssets)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.storageKey !== undefined ? { storageKey: patch.storageKey } : {}),
        ...(patch.captureSeconds !== undefined ? { captureSeconds: patch.captureSeconds } : {}),
        ...(patch.byteSize !== undefined ? { byteSize: patch.byteSize } : {}),
        ...(patch.contentType !== undefined ? { contentType: patch.contentType } : {}),
        updatedAt: new Date(),
      })
      .where(eq(videoPreviewAssets.id, id))
      .returning();
    return row ? toRecord(row) : undefined;
  }
}
