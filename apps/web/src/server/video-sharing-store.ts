import { and, eq } from 'drizzle-orm';
import type { W3dsDatabase } from './db/client';
import { videoSharingPolicies } from './db/schema';
import type { VideoSharingAudience, VideoSharingPolicy } from './video-sharing-policy';

export interface StoredVideoSharingPolicy extends VideoSharingPolicy {
  videoId: string;
  ownerId: string;
  shareToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoSharingPolicyStore {
  getByVideoId(videoId: string, ownerId: string): Promise<StoredVideoSharingPolicy | undefined>;
  getByShareToken(shareToken: string): Promise<StoredVideoSharingPolicy | undefined>;
  upsert(input: {
    videoId: string;
    ownerId: string;
    audience: VideoSharingAudience;
    readerENames: string[];
    groupENames: string[];
    shareToken: string;
  }): Promise<StoredVideoSharingPolicy>;
}

function toPolicy(row: {
  videoId: string;
  ownerId: string;
  audience: VideoSharingAudience;
  readerENames: string[];
  groupENames: string[];
  shareToken: string;
  createdAt: Date;
  updatedAt: Date;
}): StoredVideoSharingPolicy {
  return {
    videoId: row.videoId,
    ownerId: row.ownerId,
    audience: row.audience,
    readerENames: [...row.readerENames],
    groupENames: [...row.groupENames],
    shareToken: row.shareToken,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** In-memory implementation for isolated domain and route tests. */
export class InMemoryVideoSharingPolicyStore implements VideoSharingPolicyStore {
  private readonly policies = new Map<string, StoredVideoSharingPolicy>();

  async getByVideoId(
    videoId: string,
    ownerId: string,
  ): Promise<StoredVideoSharingPolicy | undefined> {
    const policy = this.policies.get(videoId);
    if (!policy || policy.ownerId !== ownerId) return undefined;
    return {
      ...policy,
      readerENames: [...policy.readerENames],
      groupENames: [...policy.groupENames],
    };
  }

  async getByShareToken(shareToken: string): Promise<StoredVideoSharingPolicy | undefined> {
    for (const policy of this.policies.values()) {
      if (policy.shareToken !== shareToken) continue;
      return {
        ...policy,
        readerENames: [...policy.readerENames],
        groupENames: [...policy.groupENames],
      };
    }
    return undefined;
  }

  async upsert(input: {
    videoId: string;
    ownerId: string;
    audience: VideoSharingAudience;
    readerENames: string[];
    groupENames: string[];
    shareToken: string;
  }): Promise<StoredVideoSharingPolicy> {
    const now = new Date().toISOString();
    const current = this.policies.get(input.videoId);
    const policy: StoredVideoSharingPolicy = {
      ...input,
      readerENames: [...input.readerENames],
      groupENames: [...input.groupENames],
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.policies.set(input.videoId, policy);
    return {
      ...policy,
      readerENames: [...policy.readerENames],
      groupENames: [...policy.groupENames],
    };
  }
}

/** PostgreSQL-backed policy store. Each video has one current sharing policy. */
export class PostgresVideoSharingPolicyStore implements VideoSharingPolicyStore {
  constructor(private readonly db: W3dsDatabase) {}

  async getByVideoId(
    videoId: string,
    ownerId: string,
  ): Promise<StoredVideoSharingPolicy | undefined> {
    const [row] = await this.db
      .select()
      .from(videoSharingPolicies)
      .where(
        and(eq(videoSharingPolicies.videoId, videoId), eq(videoSharingPolicies.ownerId, ownerId)),
      )
      .limit(1);
    return row ? toPolicy(row) : undefined;
  }

  async getByShareToken(shareToken: string): Promise<StoredVideoSharingPolicy | undefined> {
    const [row] = await this.db
      .select()
      .from(videoSharingPolicies)
      .where(eq(videoSharingPolicies.shareToken, shareToken))
      .limit(1);
    return row ? toPolicy(row) : undefined;
  }

  async upsert(input: {
    videoId: string;
    ownerId: string;
    audience: VideoSharingAudience;
    readerENames: string[];
    groupENames: string[];
    shareToken: string;
  }): Promise<StoredVideoSharingPolicy> {
    const now = new Date();
    const [row] = await this.db
      .insert(videoSharingPolicies)
      .values({
        ...input,
        readerENames: [...input.readerENames],
        groupENames: [...input.groupENames],
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: videoSharingPolicies.videoId,
        set: {
          audience: input.audience,
          readerENames: [...input.readerENames],
          groupENames: [...input.groupENames],
          shareToken: input.shareToken,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) throw new Error('Failed to persist video sharing policy.');
    return toPolicy(row);
  }
}
