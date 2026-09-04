import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@w3ds/auth';
import type { Video } from '@w3ds/types';
import type { CreatorVideoStore } from './creator-video-store';
import { PostgresCreatorVideoStore } from './creator-video-store';
import { getW3dsDatabase } from './db/client';
import { reportOperationalFailure } from './ops-observability';
import { loadServerSecurityConfig } from './server-config';
import {
  defaultVideoSharingPolicy,
  normalizeVideoSharingPolicyInput,
  toW3dsRecordAccessControl,
  type VideoSharingPolicy,
  visibilityForVideoSharingPolicy,
  type W3dsRecordAccessControl,
} from './video-sharing-policy';
import {
  PostgresVideoSharingPolicyStore,
  type StoredVideoSharingPolicy,
  type VideoSharingPolicyStore,
} from './video-sharing-store';
import { getW3dsAuthService, W3dsAuthError } from './w3ds-auth';
import {
  getVidakPrivateAdapterSyncService,
  type W3dsPrivateAdapterSyncService,
} from './w3ds-private-adapter-sync';

export type {
  VideoSharingAudience,
  VideoSharingPolicy,
  W3dsRecordAccessControl,
} from './video-sharing-policy';
export { VideoSharingPolicyError } from './video-sharing-policy';
export {
  InMemoryVideoSharingPolicyStore,
  PostgresVideoSharingPolicyStore,
} from './video-sharing-store';

export class VideoSharingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'VideoSharingError';
    this.code = code;
    this.status = status;
  }
}

export interface ManagedVideoSharingPolicy extends VideoSharingPolicy {
  /** The owner-only URL to send to a named recipient. */
  shareUrl?: string;
  /** Exact eVault `_acl` payload prepared from the user-facing policy. */
  w3dsAcl: W3dsRecordAccessControl;
  /** Whether Vidak is currently enforcing this policy for its own bytes. */
  enforcement: 'active';
}

export interface VideoSharingServiceOptions {
  videoStore: CreatorVideoStore;
  policyStore: VideoSharingPolicyStore;
  resolveUser?: (accessToken: string) => Promise<AuthUser>;
  /** Resolves user-entered eNames to the registry's canonical identity. */
  resolveRecipientEName?: (eName: string) => Promise<string>;
  createToken?: () => string;
  privateAdapterSync?: W3dsPrivateAdapterSyncService | null;
}

/**
 * Authoritative policy service for videos stored by Vidak.
 *
 * It enforces recipient access before metadata, thumbnails, or media are
 * returned. The opaque URL is a locator only; a signed-in viewer's eName must
 * match the saved recipient grant. W3DS `_acl` is derived deterministically
 * and kept ready for the official eVault writer; no undocumented remote call
 * is made here.
 */
export class VideoSharingService {
  private readonly resolveUser: (accessToken: string) => Promise<AuthUser>;
  private readonly resolveRecipientEName: (eName: string) => Promise<string>;
  private readonly createToken: () => string;
  private readonly privateAdapterSync: W3dsPrivateAdapterSyncService | null;

  constructor(private readonly options: VideoSharingServiceOptions) {
    this.resolveUser =
      options.resolveUser ??
      (async (accessToken) => {
        const session = await getW3dsAuthService().getSession(accessToken);
        return session.user;
      });
    this.resolveRecipientEName = options.resolveRecipientEName ?? (async (eName) => eName.trim());
    this.createToken = options.createToken ?? (() => `share_${randomUUID()}`);
    this.privateAdapterSync = options.privateAdapterSync ?? null;
  }

  async getOwnerPolicy(accessToken: string, videoId: string): Promise<ManagedVideoSharingPolicy> {
    const user = await this.requireUser(accessToken);
    const video = await this.requireOwnedVideo(videoId, user.id);
    const stored = await this.options.policyStore.getByVideoId(video.id, user.id);
    return this.toManagedPolicy(
      stored ?? defaultVideoSharingPolicy({ visibility: video.visibility }),
      user.eName,
    );
  }

  async updateOwnerPolicy(
    accessToken: string,
    videoId: string,
    input: unknown,
  ): Promise<ManagedVideoSharingPolicy> {
    const user = await this.requireUser(accessToken);
    const video = await this.requireOwnedVideo(videoId, user.id);
    const normalized = normalizeVideoSharingPolicyInput(input);
    if (normalized.audience === 'groups') {
      // Group membership is resolved by eVault, not by the platform. Until the
      // official eVault writer is enabled, granting local Vidak bytes to a
      // pasted group eName would be a misleading and unsafe implementation.
      throw new VideoSharingError(
        'Group sharing is not available yet because Vidak cannot verify W3DS group membership for its hosted media.',
        'group_sharing_unavailable',
        503,
      );
    }

    const readerENames = await this.resolveRecipients(normalized.readerENames, user.eName);

    const existing = await this.options.policyStore.getByVideoId(video.id, user.id);
    // A private URL is only a locator, but rotating it whenever the audience
    // narrows or otherwise changes prevents stale links from advertising a
    // current resource after a recipient is removed.
    const shareToken =
      existing && samePolicyAudience(existing, { ...normalized, readerENames })
        ? existing.shareToken
        : this.createToken();
    const stored = await this.options.policyStore.upsert({
      videoId: video.id,
      ownerId: user.id,
      ...normalized,
      readerENames,
      shareToken,
    });
    const updatedVideo = await this.options.videoStore.setOwnedVideoVisibility(
      video.id,
      user.id,
      visibilityForVideoSharingPolicy(stored),
    );
    if (!updatedVideo) {
      throw new VideoSharingError('Video was not found.', 'not_found', 404);
    }
    await this.syncVideoSafe(updatedVideo, user.eName);
    return this.toManagedPolicy(stored, user.eName);
  }

  /** Resolves a published Vidak video only when this signed-in viewer may watch it. */
  async getSharedVideo(accessToken: string, shareToken: string): Promise<Video> {
    const user = await this.requireUser(accessToken);
    const policy = await this.requireSharedPolicy(shareToken);
    const record = await this.options.videoStore.getShareableVideo(policy.videoId);
    if (!record || record.ownerId !== policy.ownerId || record.video.status !== 'published') {
      throw new VideoSharingError('This shared video is not available.', 'not_found', 404);
    }
    if (!this.viewerMayRead(policy, user)) {
      // Do not disclose whether an opaque share URL is real to an unrelated person.
      throw new VideoSharingError('This shared video is not available.', 'not_found', 404);
    }
    return record.video;
  }

  private async requireSharedPolicy(shareToken: string): Promise<StoredVideoSharingPolicy> {
    const token = shareToken.trim();
    if (!/^share_[A-Za-z0-9-]{20,}$/.test(token)) {
      throw new VideoSharingError('This shared video is not available.', 'not_found', 404);
    }
    const policy = await this.options.policyStore.getByShareToken(token);
    if (!policy || policy.audience === 'private') {
      throw new VideoSharingError('This shared video is not available.', 'not_found', 404);
    }
    return policy;
  }

  private viewerMayRead(policy: StoredVideoSharingPolicy, viewer: AuthUser): boolean {
    if (viewer.id === policy.ownerId) return true;
    if (policy.audience === 'public') return true;
    if (policy.audience === 'people') return policy.readerENames.includes(viewer.eName);
    return false;
  }

  private async requireOwnedVideo(videoId: string, ownerId: string): Promise<Video> {
    const normalized = videoId.trim();
    if (!normalized) throw new VideoSharingError('Video was not found.', 'not_found', 404);
    const video = await this.options.videoStore.getOwnedVideo(normalized, ownerId);
    if (!video) throw new VideoSharingError('Video was not found.', 'not_found', 404);
    return video;
  }

  private async requireUser(accessToken: string): Promise<AuthUser> {
    if (!accessToken.trim()) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    try {
      return await this.resolveUser(accessToken);
    } catch (error) {
      if (error instanceof W3dsAuthError) throw error;
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
  }

  private async resolveRecipients(
    readerENames: readonly string[],
    ownerEName: string,
  ): Promise<string[]> {
    if (readerENames.length === 0) return [];
    let resolved: string[];
    try {
      resolved = await Promise.all(readerENames.map((eName) => this.resolveRecipientEName(eName)));
    } catch (error) {
      if (error instanceof VideoSharingError) throw error;
      throw new VideoSharingError(
        'Vidak could not verify one or more eID names. Check the names and try again.',
        'recipient_unresolved',
        422,
      );
    }
    const owner = ownerEName.trim();
    const normalized = [...new Set(resolved.map((eName) => eName.trim()).filter(Boolean))].sort(
      (left, right) => left.localeCompare(right),
    );
    if (normalized.some((eName) => eName === owner)) {
      throw new VideoSharingError(
        'Your own eID already controls this video; remove it from the people list.',
        'owner_recipient_rejected',
        400,
      );
    }
    if (normalized.length === 0) {
      throw new VideoSharingError(
        'Add at least one verified eID name to share with.',
        'recipient_unresolved',
        422,
      );
    }
    return normalized;
  }

  private toManagedPolicy(
    policy: VideoSharingPolicy,
    ownerEName: string,
  ): ManagedVideoSharingPolicy {
    return {
      ...policy,
      readerENames: [...policy.readerENames],
      groupENames: [...policy.groupENames],
      ...(policy.shareToken && policy.audience !== 'private'
        ? { shareUrl: `/watch/shared/${encodeURIComponent(policy.shareToken)}` }
        : {}),
      w3dsAcl: toW3dsRecordAccessControl(policy, ownerEName),
      enforcement: 'active',
    };
  }

  private async syncVideoSafe(video: Video, ownerEName: string): Promise<void> {
    if (!this.privateAdapterSync) return;
    try {
      await this.privateAdapterSync.syncVideoSafe({ video, ownerEName });
    } catch (error) {
      reportOperationalFailure({ category: 'w3ds_sync', error, code: 'private_adapter_sync' });
    }
  }
}

function samePolicyAudience(
  existing: Pick<VideoSharingPolicy, 'audience' | 'readerENames' | 'groupENames'>,
  next: Pick<VideoSharingPolicy, 'audience' | 'readerENames' | 'groupENames'>,
): boolean {
  return (
    existing.audience === next.audience &&
    sameStrings(existing.readerENames, next.readerENames) &&
    sameStrings(existing.groupENames, next.groupENames)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

let sharedService: VideoSharingService | undefined;

export function getVideoSharingService(): VideoSharingService {
  if (!sharedService) {
    const db = getW3dsDatabase();
    const config = loadServerSecurityConfig();
    sharedService = new VideoSharingService({
      videoStore: new PostgresCreatorVideoStore(db),
      policyStore: new PostgresVideoSharingPolicyStore(db),
      ...(config.w3ds
        ? { resolveRecipientEName: createRegistryRecipientResolver(config.w3ds.registryBaseUrl) }
        : {}),
      privateAdapterSync: getVidakPrivateAdapterSyncService(),
    });
  }
  return sharedService;
}

export function resetVideoSharingServiceForTests(): void {
  sharedService = undefined;
}

/** Converts an authorized response into same-origin protected player endpoints. */
export function withSharedVideoPlaybackUrls(video: Video, shareToken: string): Video {
  const token = encodeURIComponent(shareToken);
  return {
    ...video,
    thumbnailUrl: `/api/videos/shared/${token}/thumbnail`,
    mediaContentUrl: `/api/videos/shared/${token}/media`,
  };
}

/**
 * Resolves a user-entered eName before it becomes a durable ACL party.
 * We never silently keep a typo or a stale alias: eVault would reject it, or
 * worse, enforce a policy different from what the owner saw in Vidak.
 */
function createRegistryRecipientResolver(
  registryBaseUrl: string,
): (eName: string) => Promise<string> {
  return async (candidate) => {
    const requested = candidate.trim();
    try {
      const url = new URL('/resolve', registryBaseUrl);
      url.searchParams.set('w3id', requested);
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        throw new VideoSharingError(
          'Vidak could not verify one or more eID names. Check the names and try again.',
          'recipient_unresolved',
          response.status >= 500 ? 503 : 422,
        );
      }
      const body = (await response.json()) as { ename?: unknown };
      const canonical = typeof body.ename === 'string' ? body.ename.trim() : '';
      if (!/^@[^\s@]{1,254}$/.test(canonical)) {
        throw new VideoSharingError(
          'Vidak could not verify one or more eID names. Check the names and try again.',
          'recipient_unresolved',
          422,
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof VideoSharingError) throw error;
      throw new VideoSharingError(
        'Vidak could not reach eID to verify the people you entered. No sharing change was made.',
        'recipient_verification_unavailable',
        503,
      );
    }
  };
}
