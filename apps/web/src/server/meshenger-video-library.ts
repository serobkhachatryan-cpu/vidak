import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import 'server-only';

import type { AuthUser } from '@w3ds/auth';
import {
  type DiscoveredVideoRecord,
  discoverCallRecordingVideos,
  discoverFileRecordVideos,
  discoverVideoMessageVideos,
  discoverW3dsFileVideos,
} from './video-space/adapters';
import { parseRetryAfter, retryDelayMs, retryWithExponentialBackoff } from './video-space/backoff';
import { assembleVideoSpaceCatalogue } from './video-space/catalogue';
import {
  createInventoryCompletenessTracker,
  type InventoryCompleteness,
  type InventoryCompletenessTracker,
  inventorySpacesClassified,
  ledgerHasUnsettledSpaces,
} from './video-space/completeness';
import type {
  InventoryScanPhase,
  InventoryScope,
  InventorySourceCounts,
} from './video-space/discovery';
import { emptySourceCounts } from './video-space/discovery';
import {
  coverageKindForOntology,
  documentedAuthorizationOntologies,
  documentedOntologyId,
} from './video-space/documented-sources';
import {
  inventoryTaskKey,
  inventoryVaultKey,
  inventoryWorkPriority,
} from './video-space/inventory-schedule';
import {
  createMemoryInventoryJobStore,
  getInventoryJobStore,
  type InventoryJobStore,
} from './video-space/job-store';
import { mapPool } from './video-space/map-pool';
import {
  classifyAuthorizedMedia,
  classifyResolvedEnvelope,
  mergeDocumentedEnvelopeFields,
} from './video-space/media-eligibility';
import { collectPaginatedEnvelopes } from './video-space/pagination';
import type { VideoSpaceAccessScope, VideoSpaceVisibility } from './video-space/visibility';
import {
  type DeferredWork,
  dedupeWork,
  drainFairVaultQueue,
  upsertWork,
} from './video-space/work-queue';
import { parseW3dsFileUri } from './w3ds-official-file-client';

const callSessionOntology = documentedOntologyId('call-recording');
const groupManifestOntology = documentedAuthorizationOntologies.groupManifest;
const chatOntology = documentedAuthorizationOntologies.chat;
const messageOntology = documentedOntologyId('video-message');
const fileOntology = documentedOntologyId('file-record');
const w3dsFileOntology = documentedOntologyId('w3ds-file');
const pageSize = 100;
const maxPages = 30;
const requestTimeoutMs = 12_000;
const sharedSpaceConcurrency = 8;
/** Fail-fast first, then Retry-After / exponential backoff until the page succeeds or is terminal. */
const maxRateLimitAttempts = 24;
const maxRejectedAttempts = 4;
// Call recordings are stored as ~45-second files. A multi-hour recording must
// remain playable through its final segment, while the authenticated stream
// route still verifies the current user on every request.
const streamLifetimeMs = 4 * 60 * 60 * 1000;
const maxCachedMediaUrls = 256;

export type MeshengerVideoKind = 'call-recording' | 'video-message' | 'file';
export type EVaultVideoAccessScope = VideoSpaceAccessScope;

export interface MeshengerVideo {
  id: string;
  kind: MeshengerVideoKind;
  title: string;
  durationSeconds?: number;
  shape?: string;
  createdAt?: string;
  /** Personal when the record owner/subject matches the authenticated eName. */
  accessScope: EVaultVideoAccessScope;
  /** Viewer-facing visibility. Never inferred as public from a missing ACL. */
  visibility: VideoSpaceVisibility;
  /** Ordered, opaque, signed, account-bound references. Never CDN URLs. */
  streamIds: string[];
  /** Server-only. Stripped before any client JSON. */
  sourceSpaceKey?: string;
  accessBasis?: 'personal' | 'membership' | 'history';
}

/** A chat surfaced from the user's own vault or a currently-authorized group. */
export interface MeshengerConversation {
  id: string;
  ownerEName: string;
  chatId: string;
  kind: 'personal' | 'group';
  title: string;
  participantCount?: number | undefined;
  role?: 'admin' | 'participant' | undefined;
  updatedAt?: string | undefined;
}

/** Safe display metadata for an authorized Meshenger message. */
export interface MeshengerMessage {
  id: string;
  ownerEName: string;
  chatId?: string | undefined;
  type: string;
  senderEName?: string | undefined;
  content?: string | undefined;
  replyToId?: string | undefined;
  createdAt?: string | undefined;
  edited: boolean;
}

export interface MeshengerLibrary {
  items: MeshengerVideo[];
  conversations: MeshengerConversation[];
  messages: MeshengerMessage[];
  completeness: InventoryCompleteness;
}

export class MeshengerVideoLibraryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_configured'
      | 'authentication_required'
      | 'remote_unavailable'
      | 'remote_rejected'
      | 'authorization_denied'
      | 'not_found'
      | 'rate_limited'
      | 'invalid_stream'
      | 'stream_expired'
      | 'unsafe_media_url',
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MeshengerVideoLibraryError';
  }
}

type RecordValue = Record<string, unknown>;
type ProgressiveAccumulators = {
  completeness: InventoryCompletenessTracker;
  referenced: Set<string>;
  found: DiscoveredVideoRecord[];
  conversations: MeshengerConversation[];
  messages: MeshengerMessage[];
};
interface Envelope {
  id: string;
  ontology: string;
  parsed: RecordValue;
}
interface StreamGrant {
  eName: string;
  fileUri: string;
  expiresAt: number;
}
interface Config {
  registryBaseUrl: string;
  platformName: string;
  signingSecret: string;
}
interface CachedMediaUrl {
  url: string;
  expiresAt: number;
}
type DiscoveredVideo = DiscoveredVideoRecord;
interface ChatReference {
  groupEName: string;
  chatId: string;
  type?: string | undefined;
  basis: 'reference' | 'official';
}
type SourceFailure = 'denied' | 'missing' | 'unavailable' | 'rate_limited' | 'rejected';
type RateLimitMode = 'fail-fast' | 'backoff';
export type SharedSpaceProbe = {
  eName: string;
  kind: 'group' | 'direct';
};
export type SharedSpaceAccess = {
  access: 'ok' | 'denied' | 'missing' | 'retry';
  member: boolean;
};
type SharedSpaceOutcome = 'indexed' | 'denied' | 'missing' | 'retry';
interface GroupDiscovery {
  videos: DiscoveredVideo[];
  conversations: MeshengerConversation[];
  messages: MeshengerMessage[];
  outcome: SharedSpaceOutcome;
  retryNeeded: boolean;
  pendingAuthors?: Array<{ authorEName: string; chatId: string }>;
  retryClass?: 'unavailable' | 'rate_limited' | 'rejected';
  retryAfterMs?: number;
  vault?: ResolvedVault;
  currentMember?: boolean;
  openedChatIds?: string[];
  chatsComplete?: boolean;
  chatsCursor?: string;
  manifestsComplete?: boolean;
  manifestsCursor?: string;
}
interface ResolvedVault {
  ownerEName: string;
  eVaultUri: string;
}

const envelopeNode = `id ontology parsed envelopes { id fieldKey value valueType }`;
const listQuery = `query AuthorizedMedia($ontologyId: ID!, $first: Int!, $after: String) {
  metaEnvelopes(filter: { ontologyId: $ontologyId }, first: $first, after: $after) {
    edges { node { ${envelopeNode} } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const chatMessagesQuery = `query AuthorizedChatMessages($ontologyId: ID!, $chatId: String!, $first: Int!, $after: String) {
  metaEnvelopes(filter: { ontologyId: $ontologyId, search: { term: $chatId, fields: ["chatId"], mode: EXACT } }, first: $first, after: $after) {
    edges { node { ${envelopeNode} } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const readQuery = `query MeshengerVideoEnvelope($id: ID!) { metaEnvelope(id: $id) { ${envelopeNode} } }`;
const cachedMediaUrls = new Map<string, CachedMediaUrl>();

function getInventoryJobStoreForLibrary(): InventoryJobStore {
  if (process.env.DATABASE_URL?.trim()) return getInventoryJobStore();
  return createMemoryInventoryJobStore();
}

/**
 * Read-only Meshenger source. It indexes envelope references and metadata only;
 * public CDN URLs are resolved only inside `resolveMediaUrl` for the stream route.
 */
export class MeshengerVideoLibrary {
  private platformToken: Promise<string> | undefined;
  private readonly jobStore: InventoryJobStore;
  private readonly now: () => number;

  constructor(
    private readonly config: Config,
    options?: { jobStore?: InventoryJobStore; now?: () => number },
  ) {
    this.jobStore = options?.jobStore ?? getInventoryJobStoreForLibrary();
    this.now = options?.now ?? (() => Date.now());
  }

  async list(user: Pick<AuthUser, 'eName' | 'eVaultUri'>): Promise<MeshengerVideo[]> {
    return (await this.listWithContext(user)).items;
  }

  /**
   * A private, read-only inventory of authorized video records the current
   * person can discover. Historical chat/media references are followed even
   * when current group membership is missing; eVault ACL still fail-closes
   * unauthorized records. Source failures never silently shrink the list.
   */
  async listWithContext(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    options?: { scope?: InventoryScope },
  ): Promise<MeshengerLibrary> {
    const eName = requireEName(user.eName);
    const ownVault = user.eVaultUri
      ? { ownerEName: eName, eVaultUri: httpUrl(user.eVaultUri) }
      : await this.resolveEVault(eName);
    const eVaultUri = ownVault.eVaultUri;
    const completeness = createInventoryCompletenessTracker();
    const scope = options?.scope;
    const includeOwned = scope !== 'shared';
    const includeShared = scope !== 'owned';
    const calls = includeOwned
      ? await this.tryListEnvelopes(
          ownVault.ownerEName,
          eVaultUri,
          callSessionOntology,
          completeness,
        )
      : [];
    const chatEnvelopes = includeShared
      ? await this.tryListEnvelopes(ownVault.ownerEName, eVaultUri, chatOntology, completeness)
      : [];
    const chatReferences = chatGrantsFromEnvelopes(chatEnvelopes, eName);
    const messages = await this.tryListEnvelopes(
      ownVault.ownerEName,
      eVaultUri,
      messageOntology,
      completeness,
    );
    const files = includeOwned
      ? await this.tryListEnvelopes(ownVault.ownerEName, eVaultUri, fileOntology, completeness)
      : [];
    const rawFiles = includeOwned
      ? await this.tryListEnvelopes(ownVault.ownerEName, eVaultUri, w3dsFileOntology, completeness)
      : [];
    if (
      completeness.snapshot().retryRateLimited > 0 &&
      calls.length + chatEnvelopes.length + messages.length + files.length + rawFiles.length === 0
    ) {
      throw new MeshengerVideoLibraryError(
        'The W3DS video source is busy. Please try again shortly.',
        'rate_limited',
        429,
      );
    }
    const referenced = new Set<string>();
    const historicalAuthors = authorsFromMessages(messages);
    const found: DiscoveredVideo[] = [];
    if (includeOwned) {
      found.push(
        ...(await this.discoverCallVideos({
          viewerEName: eName,
          sourceEName: eName,
          sourceEVaultUri: eVaultUri,
          calls,
          referenced,
        })),
      );
      found.push(...this.discoverMessageVideos(messages, referenced, eName, eName));
      found.push(...this.discoverFileVideos(eName, files, referenced, eName));
      found.push(...this.discoverRawFileVideos(eName, rawFiles, referenced, eName));
    }
    const group = includeShared
      ? await this.discoverGroupVideos(
          eName,
          chatReferences,
          referenced,
          historicalAuthors,
          completeness,
        )
      : emptySpace('indexed');
    found.push(...group.videos);
    const direct = includeShared
      ? await this.discoverDirectChatMedia(eName, chatReferences, referenced, completeness)
      : emptySpace('indexed');
    found.push(...direct.videos);

    return this.assembleLibrary({
      eName,
      found,
      completeness: completeness.snapshot(),
      conversations: [
        ...chatEnvelopesToConversations(eName, chatReferences, chatEnvelopes),
        ...group.conversations,
        ...direct.conversations,
      ],
      messages: [
        ...messages.map((message) => toMeshengerMessage(eName, message)),
        ...group.messages,
        ...direct.messages,
      ],
    });
  }

  /**
   * Progressive scoped scan. Emits the first valid page / authorized space,
   * then continues remaining pages and spaces. 429s fail fast on the first
   * wave and use exponential backoff only while continuing in the background.
   */
  async scanLibrary(
    user: Pick<AuthUser, 'eName' | 'eVaultUri'>,
    options: {
      scope: InventoryScope;
      refresh?: boolean;
      drain?: boolean;
      onSnapshot: (
        library: MeshengerLibrary,
        phase: InventoryScanPhase,
        counts: InventorySourceCounts,
      ) => void;
    },
  ): Promise<MeshengerLibrary> {
    const eName = requireEName(user.eName);
    if (options.refresh) {
      const current = await this.jobStore.getByOwner(eName);
      if (current?.status === 'complete') {
        await this.jobStore.replaceJob({
          ownerEName: eName,
          ownerEVaultUri: user.eVaultUri ? httpUrl(user.eVaultUri) : current.ownerEVaultUri,
        });
      }
    }
    const ownVault = user.eVaultUri
      ? { ownerEName: eName, eVaultUri: httpUrl(user.eVaultUri) }
      : await this.resolveEVault(eName);
    const drain = options.drain !== false;
    const counts = emptySourceCounts();
    if (options.scope === 'owned') {
      return this.scanOwnedProgressive(eName, ownVault, counts, options.onSnapshot, { drain });
    }
    if (options.scope === 'shared') {
      return this.scanSharedProgressive(eName, ownVault, counts, options.onSnapshot, { drain });
    }
    return this.scanCompleteProgressive(eName, ownVault, counts, options.onSnapshot, { drain });
  }

  /**
   * Lightweight shared-space probe for cached metadata. Does not list videos.
   * Playback and previews still authorize per request.
   */
  async probeSharedSpaceAccess(
    user: Pick<AuthUser, 'eName'>,
    space: SharedSpaceProbe,
  ): Promise<SharedSpaceAccess> {
    requireEName(user.eName);
    const vaultRead = await this.readSource(() => this.resolveEVault(space.eName), undefined);
    if (vaultRead.failure === 'denied') return { access: 'denied', member: false };
    if (vaultRead.failure === 'missing') return { access: 'missing', member: false };
    if (isRetryFailure(vaultRead.failure) || !vaultRead.value) {
      return { access: 'retry', member: false };
    }
    const vault = vaultRead.value;
    if (space.kind === 'direct') {
      const chats = await this.readSource(
        () =>
          this.listEnvelopes(vault.ownerEName, vault.eVaultUri, chatOntology, undefined, {
            maxPages: 1,
            rateLimit: 'fail-fast',
          }),
        undefined,
      );
      if (chats.failure === 'denied') return { access: 'denied', member: false };
      if (chats.failure === 'missing') return { access: 'missing', member: false };
      if (isRetryFailure(chats.failure)) return { access: 'retry', member: false };
      return { access: 'ok', member: true };
    }
    const manifests = await this.readSource(
      () =>
        this.listEnvelopes(vault.ownerEName, vault.eVaultUri, groupManifestOntology, undefined, {
          maxPages: 1,
          rateLimit: 'fail-fast',
        }),
      undefined,
    );
    if (manifests.failure === 'denied') return { access: 'denied', member: false };
    if (manifests.failure === 'missing') return { access: 'missing', member: false };
    if (isRetryFailure(manifests.failure) || !manifests.value) {
      return { access: 'retry', member: false };
    }
    const member = manifests.value.items.some((item) =>
      isCurrentGroupMember(item.parsed, user.eName),
    );
    return { access: 'ok', member };
  }

  async resolveMediaUrl(user: Pick<AuthUser, 'eName'>, streamId: string): Promise<string> {
    const grant = verifyMeshengerVideoStreamId(streamId, this.config.signingSecret);
    if (grant.eName !== requireEName(user.eName)) {
      throw new MeshengerVideoLibraryError(
        'This video is not available to this account.',
        'invalid_stream',
        403,
      );
    }
    const cacheKey = `${grant.eName}\u0000${grant.fileUri}`;
    const cached = cachedMediaUrls.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    if (cached) cachedMediaUrls.delete(cacheKey);
    const file = parseW3dsFileUri(grant.fileUri);
    if (!file) invalidStream();
    const vault = await this.resolveEVault(file.ownerEName);
    const envelope = await this.readEnvelope(
      vault.ownerEName,
      vault.eVaultUri,
      file.metaEnvelopeId,
    );
    const url = optionalString(envelope.parsed.publicUrl) ?? optionalString(envelope.parsed.url);
    if (!url)
      throw new MeshengerVideoLibraryError(
        'The video file is unavailable.',
        'remote_rejected',
        404,
      );
    const mediaUrl = safeMediaUrl(url);
    cacheMediaUrl(cacheKey, mediaUrl, grant.expiresAt);
    return mediaUrl;
  }

  /**
   * Returns the authorized file identity for a current stream grant.
   * Used to key the local preview cache without exposing the file URI to clients.
   */
  inspectStream(user: Pick<AuthUser, 'eName'>, streamId: string): { fileUri: string } {
    const grant = verifyMeshengerVideoStreamId(streamId, this.config.signingSecret);
    if (grant.eName !== requireEName(user.eName)) {
      throw new MeshengerVideoLibraryError(
        'This video is not available to this account.',
        'invalid_stream',
        403,
      );
    }
    return { fileUri: grant.fileUri };
  }

  /**
   * Drops a cached signed source after the upstream reports an expired or denied
   * media URL. The next request resolves the File envelope again.
   */
  invalidateMediaUrl(user: Pick<AuthUser, 'eName'>, streamId: string): void {
    const grant = verifyMeshengerVideoStreamId(streamId, this.config.signingSecret);
    if (grant.eName !== requireEName(user.eName)) {
      throw new MeshengerVideoLibraryError(
        'This video is not available to this account.',
        'invalid_stream',
        403,
      );
    }
    cachedMediaUrls.delete(`${grant.eName}\u0000${grant.fileUri}`);
  }

  private assembleLibrary(input: {
    eName: string;
    found: DiscoveredVideo[];
    completeness: InventoryCompleteness;
    conversations: MeshengerConversation[];
    messages: MeshengerMessage[];
  }): MeshengerLibrary {
    const completenessState = input.completeness;
    const catalogue = assembleVideoSpaceCatalogue({
      records: input.found,
      completeness: completenessState,
      viewerEName: input.eName,
      toStreamId: (fileUri) =>
        createMeshengerVideoStreamId(
          { eName: input.eName, fileUri, expiresAt: Date.now() + streamLifetimeMs },
          this.config.signingSecret,
        ),
    });
    return {
      items: catalogue.items,
      conversations: uniqueConversations(input.conversations),
      messages: uniqueMessages(input.messages).sort((a, b) =>
        (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
      ),
      completeness: completenessState,
    };
  }

  private async scanCompleteProgressive(
    eName: string,
    ownVault: ResolvedVault,
    counts: InventorySourceCounts,
    onSnapshot: (
      library: MeshengerLibrary,
      phase: InventoryScanPhase,
      counts: InventorySourceCounts,
    ) => void,
    options?: { drain?: boolean },
  ): Promise<MeshengerLibrary> {
    const accumulators: ProgressiveAccumulators = {
      completeness: createInventoryCompletenessTracker(),
      referenced: new Set<string>(),
      found: [],
      conversations: [],
      messages: [],
    };
    return this.scanSharedProgressive(eName, ownVault, counts, onSnapshot, {
      accumulators,
      emitDone: true,
      includeOwned: true,
      drain: options?.drain !== false,
    });
  }

  private async scanOwnedProgressive(
    eName: string,
    ownVault: ResolvedVault,
    counts: InventorySourceCounts,
    onSnapshot: (
      library: MeshengerLibrary,
      phase: InventoryScanPhase,
      counts: InventorySourceCounts,
    ) => void,
    options?: { accumulators?: ProgressiveAccumulators; emitDone?: boolean; drain?: boolean },
  ): Promise<MeshengerLibrary> {
    const completeness =
      options?.accumulators?.completeness ?? createInventoryCompletenessTracker();
    const referenced = options?.accumulators?.referenced ?? new Set<string>();
    const found = options?.accumulators?.found ?? [];
    const messages = options?.accumulators?.messages ?? [];
    const conversations = options?.accumulators?.conversations ?? [];
    const emitDone = options?.emitDone !== false;
    const snapshot = (phase: InventoryScanPhase) => {
      const library = this.assembleLibrary({
        eName,
        found,
        completeness: completeness.snapshot(),
        conversations,
        messages,
      });
      onSnapshot(library, phase, { ...counts });
      return library;
    };

    const sources: Array<{
      ontologyId: string;
      ingest: (envelopes: Envelope[]) => Promise<void> | void;
    }> = [
      {
        ontologyId: callSessionOntology,
        ingest: async (envelopes) => {
          found.push(
            ...(await this.discoverCallVideos({
              viewerEName: eName,
              sourceEName: eName,
              sourceEVaultUri: ownVault.eVaultUri,
              calls: envelopes,
              referenced,
            })),
          );
        },
      },
      {
        ontologyId: messageOntology,
        ingest: (envelopes) => {
          found.push(
            ...this.discoverMessageVideos(envelopes, referenced, eName, eName, completeness),
          );
          messages.push(...envelopes.map((message) => toMeshengerMessage(eName, message)));
        },
      },
      {
        ontologyId: fileOntology,
        ingest: (envelopes) => {
          found.push(...this.discoverFileVideos(eName, envelopes, referenced, eName));
        },
      },
      {
        ontologyId: w3dsFileOntology,
        ingest: (envelopes) => {
          found.push(...this.discoverRawFileVideos(eName, envelopes, referenced, eName));
        },
      },
    ];

    type OwnedWork = DeferredWork & {
      type: 'owned-source';
      source: (typeof sources)[number];
      ontologyId: string;
      after: string | null;
      retryAfterMs?: number;
    };
    const queue: OwnedWork[] = sources.map((source) => ({
      type: 'owned-source',
      source,
      ontologyId: source.ontologyId,
      after: null,
      attempts: 0,
    }));

    if (options?.drain === false) return snapshot('batch');

    await drainFairVaultQueue(
      queue,
      async (item) => {
        const page = await this.readSource(
          () =>
            this.listEnvelopes(
              ownVault.ownerEName,
              ownVault.eVaultUri,
              item.source.ontologyId,
              undefined,
              { maxPages: 1, after: item.after, rateLimit: 'fail-fast' },
            ),
          { items: [] as Envelope[], complete: false },
        );
        if (isRetryFailure(page.failure)) {
          this.queueOrFailRetry(
            completeness,
            item,
            page.failure,
            queue,
            counts,
            page.retryAfterMs,
            undefined,
            ownVault.ownerEName,
          );
          snapshot('batch');
          return;
        }
        if (item.attempts > 0) completeness.finishRetry();
        counts.personalPages += 1;
        recordCoveragePage(completeness, item.source.ontologyId);
        await item.source.ingest(page.value.items);
        if (!page.value.complete && page.value.endCursor) {
          queue.push({
            type: 'owned-source',
            source: item.source,
            ontologyId: item.source.ontologyId,
            after: page.value.endCursor,
            attempts: 0,
          });
        } else if (!page.value.complete) {
          completeness.failSpace();
        }
        snapshot('batch');
      },
      {
        vaultKey: () => ownVault.ownerEName,
        priority: (item) => inventoryWorkPriority(item.type),
        now: this.now,
        maxVaultsPerWave: 1,
        vaultNotBefore: (vault, timestamp) => this.jobStore.vaultNotBefore(vault, timestamp),
        workKey: (item) => inventoryTaskKey(item, ownVault.ownerEName),
      },
    );
    const done = emitDone && completeness.snapshot().complete;
    return snapshot(done ? 'done' : 'batch');
  }

  private async scanSharedProgressive(
    eName: string,
    ownVault: ResolvedVault,
    counts: InventorySourceCounts,
    onSnapshot: (
      library: MeshengerLibrary,
      phase: InventoryScanPhase,
      counts: InventorySourceCounts,
    ) => void,
    options?: {
      accumulators?: ProgressiveAccumulators;
      emitDone?: boolean;
      includeOwned?: boolean;
      drain?: boolean;
    },
  ): Promise<MeshengerLibrary> {
    const completeness =
      options?.accumulators?.completeness ?? createInventoryCompletenessTracker();
    const referenced = options?.accumulators?.referenced ?? new Set<string>();
    const found = options?.accumulators?.found ?? [];
    const conversations = options?.accumulators?.conversations ?? [];
    const messageRecords = options?.accumulators?.messages ?? [];
    const emitDone = options?.emitDone !== false;
    const historicalAuthors = new Map<string, Set<string>>();
    const snapshot = (phase: InventoryScanPhase) => {
      const library = this.assembleLibrary({
        eName,
        found,
        completeness: completeness.snapshot(),
        conversations,
        messages: messageRecords,
      });
      onSnapshot(library, phase, { ...counts });
      return library;
    };

    type SharedWork = DeferredWork &
      (
        | { type: 'chats'; after: string | null; retryAfterMs?: number }
        | { type: 'messages'; after: string | null; retryAfterMs?: number }
        | { type: 'group-open'; groupEName: string; retryAfterMs?: number }
        | {
            type: 'group-chats';
            spaceKey: string;
            groupEName: string;
            owner: string;
            eVaultUri: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'group-messages';
            spaceKey: string;
            groupEName: string;
            owner: string;
            eVaultUri: string;
            chatId: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'group-history';
            spaceKey: string;
            groupEName: string;
            owner: string;
            eVaultUri: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'group-manifests';
            spaceKey: string;
            groupEName: string;
            owner: string;
            eVaultUri: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'group-calls';
            spaceKey: string;
            groupEName: string;
            owner: string;
            eVaultUri: string;
            chatIds: string[];
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'group-files';
            spaceKey: string;
            groupEName: string;
            owner: string;
            eVaultUri: string;
            ontologyId: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | { type: 'direct-open'; ownerEName: string; retryAfterMs?: number }
        | {
            type: 'direct-messages';
            spaceKey: string;
            ownerEName: string;
            owner: string;
            eVaultUri: string;
            chatId: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'direct-chats';
            spaceKey: string;
            ownerEName: string;
            owner: string;
            eVaultUri: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'direct-history';
            spaceKey: string;
            ownerEName: string;
            owner: string;
            eVaultUri: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'direct-calls';
            spaceKey: string;
            ownerEName: string;
            owner: string;
            eVaultUri: string;
            chatIds: string[];
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'author-messages';
            authorEName: string;
            chatId: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'owned-source';
            ontologyId: string;
            after: string | null;
            retryAfterMs?: number;
          }
        | {
            type: 'resolve-media';
            vaultKey: string;
            owner: string;
            eVaultUri: string;
            fileUri: string;
            envelopeId?: string;
            sourceId: string;
            sourceSpaceKey: string;
            retryAfterMs?: number;
          }
      );

    const queue: SharedWork[] = [];
    const scheduledGroupChats = new Map<string, Set<string>>();
    const scheduledDirectChats = new Map<string, Set<string>>();
    const scheduledAuthors = new Set<string>();
    const remaining = new Map<string, number>();
    const settled = new Set<string>();
    const failedSpaces = new Set<string>();
    const openedGroups = new Map<string, { vault: ResolvedVault; member: boolean }>();
    const openedDirects = new Map<string, ResolvedVault>();
    const scheduledGroupFiles = new Set<string>();
    const scheduledGroupHistory = new Set<string>();
    const scheduledDirectHistory = new Set<string>();

    const addSpaceWork = (key: string, n = 1) => {
      remaining.set(key, (remaining.get(key) ?? 0) + n);
    };
    const finishSpaceWork = (key: string) => {
      const next = (remaining.get(key) ?? 1) - 1;
      remaining.set(key, next);
      if (next > 0 || settled.has(key)) return;
      settled.add(key);
      remaining.delete(key);
      if (failedSpaces.has(key)) {
        completeness.failSpace();
        counts.failed += 1;
        return;
      }
      completeness.indexSpace();
      counts.sharedSpaces += 1;
    };
    const closeSpace = (key: string, outcome: 'denied' | 'missing') => {
      if (settled.has(key)) return;
      settled.add(key);
      remaining.delete(key);
      if (outcome === 'denied') completeness.denySpace();
      else completeness.missSpace();
    };
    const failSpacePage = (
      key: string,
      item: SharedWork,
      failure: 'unavailable' | 'rate_limited' | 'rejected',
      retryAfterMs?: number,
    ) => {
      this.queueOrFailRetry(
        completeness,
        item,
        failure,
        queue,
        counts,
        retryAfterMs,
        () => {
          failedSpaces.add(key);
          finishSpaceWork(key);
        },
        inventoryVaultKey(item, ownVault.ownerEName),
      );
    };
    const continueOrFinishPage = <T extends SharedWork & { after: string | null }>(
      key: string,
      item: T,
      page: { complete: boolean; endCursor?: string },
    ) => {
      if (!page.complete && page.endCursor) {
        const { notBefore: _notBefore, ...rest } = item;
        queue.push({ ...rest, after: page.endCursor, attempts: 0 } as T);
        return;
      }
      if (!page.complete) {
        failedSpaces.add(key);
      }
      finishSpaceWork(key);
    };
    const failOpenTerminal = (key: string) => {
      if (settled.has(key)) return;
      settled.add(key);
      remaining.delete(key);
      completeness.failSpace();
    };

    const referencedGroupChats = new Map<string, Set<string>>();
    const referencedDirectChats = new Map<string, Set<string>>();
    let jobId = '';
    let jobCreatedAt = this.now();

    const persistCheckpoint = async (options?: { drainFinished?: boolean }) => {
      if (!jobId) return;
      const snapshotState = completeness.snapshot();
      const classified = inventorySpacesClassified(snapshotState);
      const terminal =
        options?.drainFinished === true &&
        queue.length === 0 &&
        remaining.size === 0 &&
        classified >= snapshotState.expected &&
        (snapshotState.retrying ?? 0) === 0;
      const library = this.assembleLibrary({
        eName,
        found,
        completeness: snapshotState,
        conversations,
        messages: messageRecords,
      });
      try {
        await this.jobStore.saveJob({
          id: jobId,
          ownerEName: eName,
          ownerEVaultUri: ownVault.eVaultUri,
          status: terminal ? 'complete' : 'running',
          completeness: snapshotState,
          ledger: {
            queue,
            found,
            drainFinished: terminal,
            remaining: [...remaining],
            settled: [...settled],
            failedSpaces: [...failedSpaces],
            openedGroups: [...openedGroups],
            openedDirects: [...openedDirects],
            scheduledGroupChats: [...scheduledGroupChats].map(([key, value]) => [key, [...value]]),
            scheduledDirectChats: [...scheduledDirectChats].map(([key, value]) => [
              key,
              [...value],
            ]),
            scheduledAuthors: [...scheduledAuthors],
            scheduledGroupFiles: [...scheduledGroupFiles],
            scheduledGroupHistory: [...scheduledGroupHistory],
            scheduledDirectHistory: [...scheduledDirectHistory],
            referenced: [...referenced],
            historicalAuthors: [...historicalAuthors].map(([key, value]) => [key, [...value]]),
            referencedGroupChats: [...referencedGroupChats].map(([key, value]) => [
              key,
              [...value],
            ]),
            referencedDirectChats: [...referencedDirectChats].map(([key, value]) => [
              key,
              [...value],
            ]),
          },
          items: library.items,
          conversations: [...conversations],
          messages: [...messageRecords],
          sourceCounts: { ...counts },
          createdAt: jobCreatedAt,
          updatedAt: this.now(),
          ...(terminal ? { completedAt: this.now() } : {}),
        });
      } catch {
        // Keep draining due work even when the job row cannot be written.
      }
      const open = queue.map((item) => {
        const vaultKey = inventoryVaultKey(item, ownVault.ownerEName);
        return {
          id: randomUUID(),
          jobId,
          taskKey: inventoryTaskKey(item, vaultKey),
          kind: item.type,
          vaultKey,
          ...(item.type === 'owned-source' || item.type === 'group-files'
            ? { ontologyId: item.ontologyId }
            : {}),
          cursorAfter: 'after' in item ? item.after : null,
          attempts: item.attempts,
          notBefore: item.notBefore ?? 0,
          status: 'pending' as const,
          priority: inventoryWorkPriority(item.type),
          payload: item as unknown as Record<string, unknown>,
        };
      });
      try {
        await this.jobStore.replaceOpenTasks(jobId, open);
      } catch {
        // Ledger.queue still has the work. Do not abort drain because task
        // rows failed (Postgres rejects NUL bytes in text, for example).
      }
    };

    const restoreStringSet = (value: unknown, target: Set<string>) => {
      if (!Array.isArray(value)) return;
      for (const entry of value) if (typeof entry === 'string') target.add(entry);
    };
    const restoreStringMapSet = (value: unknown, target: Map<string, Set<string>>) => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1]))
          continue;
        target.set(
          entry[0],
          new Set(entry[1].filter((item): item is string => typeof item === 'string')),
        );
      }
    };

    const existingJob = await this.jobStore.getByOwner(eName);
    const job =
      existingJob ??
      (await this.jobStore.createJob({
        ownerEName: eName,
        ownerEVaultUri: ownVault.eVaultUri,
      }));
    jobId = job.id;
    jobCreatedAt = job.createdAt;
    const drainFinished = job.ledger.drainFinished === true;
    const savedQueue = Array.isArray(job.ledger.queue) ? (job.ledger.queue as SharedWork[]) : [];
    const openTasks = await this.jobStore.loadOpenTasks(job.id);
    const restoreJobLedger = () => {
      completeness.hydrate(job.completeness);
      Object.assign(counts, job.sourceCounts);
      if (Array.isArray(job.ledger.found)) found.push(...(job.ledger.found as DiscoveredVideo[]));
      conversations.push(...job.conversations);
      messageRecords.push(...job.messages);
      if (Array.isArray(job.ledger.remaining)) {
        for (const entry of job.ledger.remaining as [string, number][])
          remaining.set(entry[0], entry[1]);
      }
      restoreStringSet(job.ledger.settled, settled);
      restoreStringSet(job.ledger.failedSpaces, failedSpaces);
      restoreStringSet(job.ledger.scheduledAuthors, scheduledAuthors);
      restoreStringSet(job.ledger.scheduledGroupFiles, scheduledGroupFiles);
      restoreStringSet(job.ledger.scheduledGroupHistory, scheduledGroupHistory);
      restoreStringSet(job.ledger.scheduledDirectHistory, scheduledDirectHistory);
      restoreStringSet(job.ledger.referenced, referenced);
      restoreStringMapSet(job.ledger.scheduledGroupChats, scheduledGroupChats);
      restoreStringMapSet(job.ledger.scheduledDirectChats, scheduledDirectChats);
      restoreStringMapSet(job.ledger.historicalAuthors, historicalAuthors);
      restoreStringMapSet(job.ledger.referencedGroupChats, referencedGroupChats);
      restoreStringMapSet(job.ledger.referencedDirectChats, referencedDirectChats);
      if (Array.isArray(job.ledger.openedGroups)) {
        for (const entry of job.ledger.openedGroups as [
          string,
          { vault: ResolvedVault; member: boolean },
        ][]) {
          openedGroups.set(entry[0], entry[1]);
        }
      }
      if (Array.isArray(job.ledger.openedDirects)) {
        for (const entry of job.ledger.openedDirects as [string, ResolvedVault][]) {
          openedDirects.set(entry[0], entry[1]);
        }
      }
    };
    const seedInitialQueue = () => {
      queue.push(
        { type: 'chats', after: null, attempts: 0 },
        { type: 'messages', after: null, attempts: 0 },
      );
      if (options?.includeOwned) {
        for (const ontologyId of [callSessionOntology, fileOntology, w3dsFileOntology]) {
          queue.push({ type: 'owned-source', ontologyId, after: null, attempts: 0 });
        }
      }
    };

    if (
      drainFinished &&
      savedQueue.length === 0 &&
      openTasks.length === 0 &&
      (job.completeness.retrying ?? 0) === 0 &&
      !ledgerHasUnsettledSpaces(job.ledger) &&
      inventorySpacesClassified(job.completeness) >= job.completeness.expected
    ) {
      restoreJobLedger();
      completeness.markScanFinished();
      return snapshot('done');
    }
    restoreJobLedger();
    if (openTasks.length > 0) {
      for (const task of openTasks) queue.push(task.payload as unknown as SharedWork);
    } else if (savedQueue.length > 0) {
      queue.push(...savedQueue);
    } else if (
      remaining.size > 0 ||
      inventorySpacesClassified(completeness.snapshot()) < job.completeness.expected
    ) {
      // Fall through to reseedUnsettledWork after helpers are defined.
    } else {
      seedInitialQueue();
    }
    const workKey = (item: SharedWork) =>
      inventoryTaskKey(item, inventoryVaultKey(item, ownVault.ownerEName));
    dedupeWork(queue, workKey);
    completeness.reconcileRetrying(queue.filter((item) => item.attempts > 0).length);

    if (options?.drain === false) {
      if (savedQueue.length === 0 && openTasks.length === 0) await persistCheckpoint();
      return snapshot('batch');
    }

    const enqueueGroupMessages = (
      groupEName: string,
      vault: ResolvedVault,
      chatIds: Iterable<string>,
    ) => {
      const seen = scheduledGroupChats.get(groupEName) ?? new Set<string>();
      for (const chatId of chatIds) {
        if (seen.has(chatId)) continue;
        seen.add(chatId);
        addSpaceWork(groupEName);
        queue.push({
          type: 'group-messages',
          spaceKey: groupEName,
          groupEName,
          owner: vault.ownerEName,
          eVaultUri: vault.eVaultUri,
          chatId,
          after: null,
          attempts: 0,
        });
      }
      scheduledGroupChats.set(groupEName, seen);
    };

    const enqueueGroupFiles = (groupEName: string, vault: ResolvedVault) => {
      if (scheduledGroupFiles.has(groupEName)) return;
      scheduledGroupFiles.add(groupEName);
      for (const ontologyId of [fileOntology, w3dsFileOntology]) {
        addSpaceWork(groupEName);
        queue.push({
          type: 'group-files',
          spaceKey: groupEName,
          groupEName,
          owner: vault.ownerEName,
          eVaultUri: vault.eVaultUri,
          ontologyId,
          after: null,
          attempts: 0,
        });
      }
    };

    const enqueueGroupHistory = (groupEName: string, vault: ResolvedVault) => {
      if (scheduledGroupHistory.has(groupEName)) return;
      scheduledGroupHistory.add(groupEName);
      addSpaceWork(groupEName);
      queue.push({
        type: 'group-history',
        spaceKey: groupEName,
        groupEName,
        owner: vault.ownerEName,
        eVaultUri: vault.eVaultUri,
        after: null,
        attempts: 0,
      });
    };

    const enqueueDirectHistory = (ownerEName: string, vault: ResolvedVault) => {
      if (scheduledDirectHistory.has(ownerEName)) return;
      scheduledDirectHistory.add(ownerEName);
      addSpaceWork(ownerEName);
      queue.push({
        type: 'direct-history',
        spaceKey: ownerEName,
        ownerEName,
        owner: vault.ownerEName,
        eVaultUri: vault.eVaultUri,
        after: null,
        attempts: 0,
      });
    };

    const enqueueGroup = (groupEName: string, chatIds: Iterable<string>) => {
      if (settled.has(groupEName) && !openedGroups.has(groupEName)) return;
      const referenced = referencedGroupChats.get(groupEName) ?? new Set<string>();
      const fresh = [...chatIds].filter((id) => !referenced.has(id));
      for (const id of chatIds) referenced.add(id);
      referencedGroupChats.set(groupEName, referenced);
      const isNew = !remaining.has(groupEName) && !settled.has(groupEName);
      if (isNew) {
        completeness.expectSpace();
        remaining.set(groupEName, 1);
        queue.push({ type: 'group-open', groupEName, attempts: 0 });
        return;
      }
      const opened = openedGroups.get(groupEName);
      if (opened && fresh.length) enqueueGroupMessages(groupEName, opened.vault, fresh);
    };
    const enqueueDirect = (ownerEName: string, chatIds: Iterable<string>) => {
      if (ownerEName === eName) return;
      if (settled.has(ownerEName) && !openedDirects.has(ownerEName)) return;
      const referenced = referencedDirectChats.get(ownerEName) ?? new Set<string>();
      const fresh = [...chatIds].filter((id) => !referenced.has(id));
      for (const id of chatIds) referenced.add(id);
      referencedDirectChats.set(ownerEName, referenced);
      const isNew = !remaining.has(ownerEName) && !settled.has(ownerEName);
      if (isNew) {
        completeness.expectSpace();
        remaining.set(ownerEName, 1);
        scheduledDirectChats.set(ownerEName, new Set(referenced));
        queue.push({ type: 'direct-open', ownerEName, attempts: 0 });
        return;
      }
      const opened = openedDirects.get(ownerEName);
      if (opened && fresh.length) {
        const seen = scheduledDirectChats.get(ownerEName) ?? new Set<string>();
        for (const chatId of fresh) {
          if (seen.has(chatId)) continue;
          seen.add(chatId);
          addSpaceWork(ownerEName);
          queue.push({
            type: 'direct-messages',
            spaceKey: ownerEName,
            ownerEName,
            owner: opened.ownerEName,
            eVaultUri: opened.eVaultUri,
            chatId,
            after: null,
            attempts: 0,
          });
        }
        scheduledDirectChats.set(ownerEName, seen);
      }
    };
    const enqueueAuthor = (authorEName: string, chatId: string, alreadyFailed = false) => {
      const key = `${authorEName}\u0000${chatId}`;
      if (scheduledAuthors.has(key)) return;
      if (sameEName(authorEName, eName)) return;
      scheduledAuthors.add(key);
      if (alreadyFailed) completeness.queueRetry();
      queue.push({
        type: 'author-messages',
        authorEName,
        chatId,
        after: null,
        attempts: alreadyFailed ? 1 : 0,
      });
    };
    const reseedUnsettledWork = () => {
      for (const [spaceKey, count] of remaining) {
        if (count <= 0 || settled.has(spaceKey)) continue;
        const opened = openedGroups.get(spaceKey);
        if (opened) {
          const chatIds = referencedGroupChats.get(spaceKey) ?? new Set<string>();
          enqueueGroupMessages(spaceKey, opened.vault, chatIds);
          queue.push({
            type: 'group-calls',
            spaceKey,
            groupEName: spaceKey,
            owner: opened.vault.ownerEName,
            eVaultUri: opened.vault.eVaultUri,
            chatIds: [...chatIds],
            after: null,
            attempts: 0,
          });
          if (opened.member) {
            enqueueGroupFiles(spaceKey, opened.vault);
            enqueueGroupHistory(spaceKey, opened.vault);
          }
          continue;
        }
        const directVault = openedDirects.get(spaceKey);
        if (directVault) {
          const chatIds = referencedDirectChats.get(spaceKey) ?? new Set<string>();
          const seen = scheduledDirectChats.get(spaceKey) ?? new Set<string>();
          for (const chatId of chatIds) {
            if (seen.has(chatId)) continue;
            seen.add(chatId);
            addSpaceWork(spaceKey);
            queue.push({
              type: 'direct-messages',
              spaceKey,
              ownerEName: spaceKey,
              owner: directVault.ownerEName,
              eVaultUri: directVault.eVaultUri,
              chatId,
              after: null,
              attempts: 0,
            });
          }
          scheduledDirectChats.set(spaceKey, seen);
          queue.push({
            type: 'direct-calls',
            spaceKey,
            ownerEName: spaceKey,
            owner: directVault.ownerEName,
            eVaultUri: directVault.eVaultUri,
            chatIds: [...chatIds],
            after: null,
            attempts: 0,
          });
          continue;
        }
        if (referencedGroupChats.has(spaceKey)) {
          queue.push({ type: 'group-open', groupEName: spaceKey, attempts: 0 });
          continue;
        }
        queue.push({ type: 'direct-open', ownerEName: spaceKey, attempts: 0 });
      }
    };
    if (
      queue.length === 0 &&
      (remaining.size > 0 ||
        inventorySpacesClassified(completeness.snapshot()) < job.completeness.expected)
    ) {
      reseedUnsettledWork();
    }
    const ingestReferences = (envelopes: Envelope[]) => {
      const references = chatGrantsFromEnvelopes(envelopes, eName);
      conversations.push(...chatEnvelopesToConversations(eName, references, envelopes));
      for (const reference of references) {
        completeness.recordGrant(reference.basis);
        if (reference.type === 'group' || !reference.type) {
          enqueueGroup(reference.groupEName, [reference.chatId]);
        }
        if (reference.type !== 'group') enqueueDirect(reference.groupEName, [reference.chatId]);
      }
    };
    const ingestMessagePage = (
      sourceEName: string,
      chatId: string,
      items: Envelope[],
      vault?: ResolvedVault,
    ) => {
      found.push(
        ...this.discoverMessageVideos(
          items,
          referenced,
          eName,
          sourceEName,
          completeness,
          (fileUri, envelopeId) => {
            if (!vault) return;
            const vaultKey = parseW3dsFileUri(fileUri)?.ownerEName ?? vault.ownerEName;
            queue.push({
              type: 'resolve-media',
              vaultKey,
              owner: vault.ownerEName,
              eVaultUri: vault.eVaultUri,
              fileUri,
              envelopeId,
              sourceId: `message:${sourceEName}:${chatId}`,
              sourceSpaceKey: sourceEName,
              attempts: 0,
            });
          },
        ),
      );
      messageRecords.push(...items.map((message) => toMeshengerMessage(sourceEName, message)));
      mergeAuthorMap(historicalAuthors, authorsFromMessages(items));
      for (const author of historicalAuthors.get(chatId) ?? []) {
        if (sameEName(author, sourceEName) || sameEName(author, eName)) continue;
        enqueueAuthor(author, chatId);
      }
    };

    const claimed = await this.jobStore.tryClaimDrain(jobId, this.now());
    if (!claimed) return snapshot('batch');
    try {
      await persistCheckpoint();
      let keepDraining = true;
      while (keepDraining) {
        await drainFairVaultQueue(
          queue,
          async (item) => {
            if (item.type === 'owned-source') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(
                    ownVault.ownerEName,
                    ownVault.eVaultUri,
                    item.ontologyId,
                    undefined,
                    {
                      maxPages: 1,
                      after: item.after,
                      rateLimit: 'fail-fast',
                    },
                  ),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                this.queueOrFailRetry(
                  completeness,
                  item,
                  page.failure,
                  queue,
                  counts,
                  page.retryAfterMs,
                  undefined,
                  ownVault.ownerEName,
                );
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              counts.personalPages += 1;
              recordCoveragePage(completeness, item.ontologyId);
              if (item.ontologyId === callSessionOntology) {
                found.push(
                  ...(await this.discoverCallVideos({
                    viewerEName: eName,
                    sourceEName: eName,
                    sourceEVaultUri: ownVault.eVaultUri,
                    calls: page.value.items,
                    referenced,
                  })),
                );
              } else if (item.ontologyId === fileOntology) {
                found.push(...this.discoverFileVideos(eName, page.value.items, referenced, eName));
              } else {
                found.push(
                  ...this.discoverRawFileVideos(eName, page.value.items, referenced, eName),
                );
              }
              if (!page.value.complete && page.value.endCursor) {
                queue.push({
                  type: 'owned-source',
                  ontologyId: item.ontologyId,
                  after: page.value.endCursor,
                  attempts: 0,
                });
              }
              snapshot('batch');
              return;
            }
            if (item.type === 'resolve-media') {
              await this.resolveQueuedMedia(
                item,
                found,
                referenced,
                eName,
                completeness,
                queue,
                counts,
              );
              snapshot('batch');
              return;
            }
            if (item.type === 'chats' || item.type === 'messages') {
              const ontologyId = item.type === 'chats' ? chatOntology : messageOntology;
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(
                    ownVault.ownerEName,
                    ownVault.eVaultUri,
                    ontologyId,
                    undefined,
                    {
                      maxPages: 1,
                      after: item.after,
                      rateLimit: 'fail-fast',
                    },
                  ),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                this.queueOrFailRetry(
                  completeness,
                  item,
                  page.failure,
                  queue,
                  counts,
                  page.retryAfterMs,
                  undefined,
                  ownVault.ownerEName,
                );
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              counts.personalPages += 1;
              recordCoveragePage(completeness, ontologyId);
              if (item.type === 'chats') ingestReferences(page.value.items);
              else {
                found.push(
                  ...this.discoverMessageVideos(
                    page.value.items,
                    referenced,
                    eName,
                    eName,
                    completeness,
                    (fileUri, envelopeId) => {
                      queue.push({
                        type: 'resolve-media',
                        vaultKey: parseW3dsFileUri(fileUri)?.ownerEName ?? ownVault.ownerEName,
                        owner: ownVault.ownerEName,
                        eVaultUri: ownVault.eVaultUri,
                        fileUri,
                        envelopeId,
                        sourceId: 'owned-message',
                        sourceSpaceKey: eName,
                        attempts: 0,
                      });
                    },
                  ),
                );
                messageRecords.push(
                  ...page.value.items.map((message) => toMeshengerMessage(eName, message)),
                );
                mergeAuthorMap(historicalAuthors, authorsFromMessages(page.value.items));
                for (const [chatId, authors] of historicalAuthors) {
                  for (const author of authors) enqueueAuthor(author, chatId);
                }
              }
              if (!page.value.complete && page.value.endCursor) {
                queue.push({ type: item.type, after: page.value.endCursor, attempts: 0 });
              } else if (!page.value.complete) {
                completeness.markRetry();
              }
              snapshot('batch');
              return;
            }

            if (item.type === 'group-open') {
              const referencedIds = referencedGroupChats.get(item.groupEName) ?? new Set<string>();
              const space = await this.readGroupSpace({
                viewerEName: eName,
                groupEName: item.groupEName,
                chatIds: referencedIds,
                referenced,
                historicalAuthors,
                completeness,
                rateLimit: 'fail-fast',
                silenceRetries: true,
                mode: 'open',
              });
              if (space.outcome === 'retry') {
                this.queueOrFailRetry(
                  completeness,
                  item,
                  space.retryClass ?? 'rate_limited',
                  queue,
                  counts,
                  space.retryAfterMs,
                  () => failOpenTerminal(item.groupEName),
                );
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              if (space.outcome === 'denied') {
                closeSpace(item.groupEName, 'denied');
                snapshot('batch');
                return;
              }
              if (space.outcome === 'missing') {
                closeSpace(item.groupEName, 'missing');
                snapshot('batch');
                return;
              }
              const vault = space.vault;
              if (!vault) {
                closeSpace(item.groupEName, 'missing');
                snapshot('batch');
                return;
              }
              openedGroups.set(item.groupEName, { vault, member: space.currentMember === true });
              conversations.push(...space.conversations);
              recordCoveragePage(completeness, groupManifestOntology);
              recordCoveragePage(completeness, chatOntology);
              const chatIds = new Set([...referencedIds, ...(space.openedChatIds ?? [])]);
              enqueueGroupMessages(item.groupEName, vault, chatIds);
              addSpaceWork(item.groupEName);
              queue.push({
                type: 'group-calls',
                spaceKey: item.groupEName,
                groupEName: item.groupEName,
                owner: vault.ownerEName,
                eVaultUri: vault.eVaultUri,
                chatIds: [...chatIds],
                after: null,
                attempts: 0,
              });
              if (space.currentMember) {
                enqueueGroupFiles(item.groupEName, vault);
                enqueueGroupHistory(item.groupEName, vault);
              } else if (space.manifestsComplete === false && space.manifestsCursor) {
                addSpaceWork(item.groupEName);
                queue.push({
                  type: 'group-manifests',
                  spaceKey: item.groupEName,
                  groupEName: item.groupEName,
                  owner: vault.ownerEName,
                  eVaultUri: vault.eVaultUri,
                  after: space.manifestsCursor,
                  attempts: 0,
                });
              }
              if (space.chatsComplete === false && space.chatsCursor) {
                addSpaceWork(item.groupEName);
                queue.push({
                  type: 'group-chats',
                  spaceKey: item.groupEName,
                  groupEName: item.groupEName,
                  owner: vault.ownerEName,
                  eVaultUri: vault.eVaultUri,
                  after: space.chatsCursor,
                  attempts: 0,
                });
              }
              finishSpaceWork(item.groupEName);
              snapshot('batch');
              return;
            }

            if (item.type === 'group-chats') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(item.owner, item.eVaultUri, chatOntology, undefined, {
                    maxPages: 1,
                    after: item.after,
                    rateLimit: 'fail-fast',
                  }),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, chatOntology);
              const opened = openedGroups.get(item.groupEName);
              if (opened) {
                const chatIds = page.value.items
                  .map((chat) => optionalString(chat.parsed.id) ?? chat.id)
                  .filter(Boolean);
                enqueueGroupMessages(item.groupEName, opened.vault, chatIds);
              }
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'group-messages') {
              const page = await this.readSource(
                () =>
                  this.listMessagesForChat(
                    item.owner,
                    item.eVaultUri,
                    item.chatId,
                    undefined,
                    'fail-fast',
                    {
                      maxPages: 1,
                      after: item.after,
                    },
                  ),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, messageOntology);
              if (item.after === null) completeness.recordGroupHistory();
              ingestMessagePage(item.groupEName, item.chatId, page.value.items, {
                ownerEName: item.owner,
                eVaultUri: item.eVaultUri,
              });
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'group-history') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(item.owner, item.eVaultUri, messageOntology, undefined, {
                    maxPages: 1,
                    after: item.after,
                    rateLimit: 'fail-fast',
                  }),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, messageOntology);
              found.push(
                ...this.discoverMessageVideos(
                  page.value.items,
                  referenced,
                  eName,
                  item.groupEName,
                  completeness,
                  (fileUri, envelopeId) => {
                    queue.push({
                      type: 'resolve-media',
                      vaultKey: parseW3dsFileUri(fileUri)?.ownerEName ?? item.owner,
                      owner: item.owner,
                      eVaultUri: item.eVaultUri,
                      fileUri,
                      envelopeId,
                      sourceId: `group-history:${item.spaceKey}`,
                      sourceSpaceKey: item.groupEName,
                      attempts: 0,
                    });
                  },
                ),
              );
              messageRecords.push(
                ...page.value.items.map((message) => toMeshengerMessage(item.groupEName, message)),
              );
              mergeAuthorMap(historicalAuthors, authorsFromMessages(page.value.items));
              for (const [chatId, authors] of historicalAuthors) {
                for (const author of authors) {
                  if (sameEName(author, item.groupEName) || sameEName(author, eName)) continue;
                  enqueueAuthor(author, chatId);
                }
              }
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'group-manifests') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(item.owner, item.eVaultUri, groupManifestOntology, undefined, {
                    maxPages: 1,
                    after: item.after,
                    rateLimit: 'fail-fast',
                  }),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, groupManifestOntology);
              const opened = openedGroups.get(item.groupEName);
              const becameMember = page.value.items.some((manifest) =>
                isCurrentGroupMember(manifest.parsed, eName),
              );
              if (becameMember && opened && !opened.member) {
                openedGroups.set(item.groupEName, { vault: opened.vault, member: true });
                enqueueGroupFiles(item.groupEName, opened.vault);
                enqueueGroupHistory(item.groupEName, opened.vault);
                addSpaceWork(item.groupEName);
                queue.push({
                  type: 'group-chats',
                  spaceKey: item.groupEName,
                  groupEName: item.groupEName,
                  owner: opened.vault.ownerEName,
                  eVaultUri: opened.vault.eVaultUri,
                  after: null,
                  attempts: 0,
                });
              }
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'group-calls') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(item.owner, item.eVaultUri, callSessionOntology, undefined, {
                    maxPages: 1,
                    after: item.after,
                    rateLimit: 'fail-fast',
                  }),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, callSessionOntology);
              found.push(
                ...(await this.discoverCallVideos({
                  viewerEName: eName,
                  sourceEName: item.groupEName,
                  sourceEVaultUri: item.eVaultUri,
                  calls: page.value.items,
                  chatIds: new Set(item.chatIds),
                  referenced,
                })),
              );
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'group-files') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(item.owner, item.eVaultUri, item.ontologyId, undefined, {
                    maxPages: 1,
                    after: item.after,
                    rateLimit: 'fail-fast',
                  }),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, item.ontologyId);
              if (item.ontologyId === w3dsFileOntology) {
                found.push(
                  ...this.discoverRawFileVideos(item.owner, page.value.items, referenced, eName),
                );
              } else {
                found.push(
                  ...this.discoverFileVideos(item.owner, page.value.items, referenced, eName),
                );
              }
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'direct-open') {
              const referencedIds = referencedDirectChats.get(item.ownerEName) ?? new Set<string>();
              const space = await this.readDirectSpace({
                viewerEName: eName,
                ownerEName: item.ownerEName,
                chatIds: referencedIds,
                referenced,
                completeness,
                rateLimit: 'fail-fast',
                silenceRetries: true,
                mode: 'open',
              });
              if (space.outcome === 'retry') {
                this.queueOrFailRetry(
                  completeness,
                  item,
                  space.retryClass ?? 'rate_limited',
                  queue,
                  counts,
                  space.retryAfterMs,
                  () => failOpenTerminal(item.ownerEName),
                );
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              if (space.outcome === 'denied') {
                closeSpace(item.ownerEName, 'denied');
                snapshot('batch');
                return;
              }
              if (space.outcome === 'missing') {
                closeSpace(item.ownerEName, 'missing');
                snapshot('batch');
                return;
              }
              const vault = space.vault;
              if (!vault) {
                closeSpace(item.ownerEName, 'missing');
                snapshot('batch');
                return;
              }
              openedDirects.set(item.ownerEName, vault);
              conversations.push(...space.conversations);
              recordCoveragePage(completeness, chatOntology);
              const chatIds = [...new Set([...(space.openedChatIds ?? []), ...referencedIds])];
              for (const chatId of chatIds) {
                addSpaceWork(item.ownerEName);
                queue.push({
                  type: 'direct-messages',
                  spaceKey: item.ownerEName,
                  ownerEName: item.ownerEName,
                  owner: vault.ownerEName,
                  eVaultUri: vault.eVaultUri,
                  chatId,
                  after: null,
                  attempts: 0,
                });
              }
              addSpaceWork(item.ownerEName);
              queue.push({
                type: 'direct-calls',
                spaceKey: item.ownerEName,
                ownerEName: item.ownerEName,
                owner: vault.ownerEName,
                eVaultUri: vault.eVaultUri,
                chatIds,
                after: null,
                attempts: 0,
              });
              enqueueDirectHistory(item.ownerEName, vault);
              if (space.chatsComplete === false && space.chatsCursor) {
                addSpaceWork(item.ownerEName);
                queue.push({
                  type: 'direct-chats',
                  spaceKey: item.ownerEName,
                  ownerEName: item.ownerEName,
                  owner: vault.ownerEName,
                  eVaultUri: vault.eVaultUri,
                  after: space.chatsCursor,
                  attempts: 0,
                });
              }
              finishSpaceWork(item.ownerEName);
              snapshot('batch');
              return;
            }

            if (item.type === 'direct-messages') {
              const page = await this.readSource(
                () =>
                  this.listMessagesForChat(
                    item.owner,
                    item.eVaultUri,
                    item.chatId,
                    undefined,
                    'fail-fast',
                    {
                      maxPages: 1,
                      after: item.after,
                    },
                  ),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, messageOntology);
              if (item.after === null) completeness.recordDirectChat();
              ingestMessagePage(item.ownerEName, item.chatId, page.value.items, {
                ownerEName: item.owner,
                eVaultUri: item.eVaultUri,
              });
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'direct-chats') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(item.owner, item.eVaultUri, chatOntology, undefined, {
                    maxPages: 1,
                    after: item.after,
                    rateLimit: 'fail-fast',
                  }),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, chatOntology);
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'direct-history') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(item.owner, item.eVaultUri, messageOntology, undefined, {
                    maxPages: 1,
                    after: item.after,
                    rateLimit: 'fail-fast',
                  }),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, messageOntology);
              found.push(
                ...this.discoverMessageVideos(
                  page.value.items,
                  referenced,
                  eName,
                  item.ownerEName,
                  completeness,
                  (fileUri, envelopeId) => {
                    queue.push({
                      type: 'resolve-media',
                      vaultKey: parseW3dsFileUri(fileUri)?.ownerEName ?? item.owner,
                      owner: item.owner,
                      eVaultUri: item.eVaultUri,
                      fileUri,
                      envelopeId,
                      sourceId: `direct-history:${item.spaceKey}`,
                      sourceSpaceKey: item.ownerEName,
                      attempts: 0,
                    });
                  },
                ),
              );
              messageRecords.push(
                ...page.value.items.map((message) => toMeshengerMessage(item.ownerEName, message)),
              );
              mergeAuthorMap(historicalAuthors, authorsFromMessages(page.value.items));
              for (const [chatId, authors] of historicalAuthors) {
                for (const author of authors) {
                  if (sameEName(author, item.ownerEName) || sameEName(author, eName)) continue;
                  enqueueAuthor(author, chatId);
                }
              }
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type === 'direct-calls') {
              const page = await this.readSource(
                () =>
                  this.listEnvelopes(item.owner, item.eVaultUri, callSessionOntology, undefined, {
                    maxPages: 1,
                    after: item.after,
                    rateLimit: 'fail-fast',
                  }),
                { items: [] as Envelope[], complete: false },
              );
              if (isRetryFailure(page.failure)) {
                failSpacePage(item.spaceKey, item, page.failure, page.retryAfterMs);
                snapshot('batch');
                return;
              }
              if (item.attempts > 0) completeness.finishRetry();
              recordCoveragePage(completeness, callSessionOntology);
              found.push(
                ...(await this.discoverCallVideos({
                  viewerEName: eName,
                  sourceEName: item.ownerEName,
                  sourceEVaultUri: item.eVaultUri,
                  calls: page.value.items,
                  chatIds: new Set(item.chatIds),
                  referenced,
                })),
              );
              continueOrFinishPage(item.spaceKey, item, page.value);
              snapshot('batch');
              return;
            }

            if (item.type !== 'author-messages') return;

            const authorRead = await this.readSource(
              async () => {
                const authorVault = await this.resolveEVault(item.authorEName);
                return this.listMessagesForChat(
                  authorVault.ownerEName,
                  authorVault.eVaultUri,
                  item.chatId,
                  undefined,
                  'fail-fast',
                  { maxPages: 1, after: item.after },
                );
              },
              { items: [] as Envelope[], complete: false },
            );
            if (isRetryFailure(authorRead.failure)) {
              this.queueOrFailRetry(
                completeness,
                item,
                authorRead.failure,
                queue,
                counts,
                authorRead.retryAfterMs,
              );
              snapshot('batch');
              return;
            }
            if (item.attempts > 0) completeness.finishRetry();
            if (!authorRead.failure) {
              recordCoveragePage(completeness, messageOntology);
              found.push(
                ...this.discoverMessageVideos(
                  authorRead.value.items,
                  referenced,
                  eName,
                  item.authorEName,
                  completeness,
                  (fileUri, envelopeId) => {
                    queue.push({
                      type: 'resolve-media',
                      vaultKey: parseW3dsFileUri(fileUri)?.ownerEName ?? item.authorEName,
                      owner: item.authorEName,
                      eVaultUri: '',
                      fileUri,
                      envelopeId,
                      sourceId: `author-messages:${item.chatId}`,
                      sourceSpaceKey: item.authorEName,
                      attempts: 0,
                    });
                  },
                ),
              );
              messageRecords.push(
                ...authorRead.value.items.map((message) =>
                  toMeshengerMessage(item.authorEName, message),
                ),
              );
              if (!authorRead.value.complete && authorRead.value.endCursor) {
                const { notBefore: _notBefore, ...rest } = item;
                queue.push({
                  ...rest,
                  after: authorRead.value.endCursor,
                  attempts: 0,
                });
              }
            }
            snapshot('batch');
          },
          {
            vaultKey: (item) => inventoryVaultKey(item, ownVault.ownerEName),
            priority: (item) => inventoryWorkPriority(item.type),
            now: this.now,
            maxVaultsPerWave: sharedSpaceConcurrency,
            vaultNotBefore: (vault, timestamp) => this.jobStore.vaultNotBefore(vault, timestamp),
            workKey,
            persist: async () => {
              try {
                await this.jobStore.heartbeatDrain(jobId, this.now());
                await persistCheckpoint();
              } catch {
                // Keep draining due work; the next pump retries persistence.
              }
            },
          },
        );
        if (remaining.size === 0) {
          keepDraining = false;
          break;
        }
        if (queue.length > 0) continue;
        reseedUnsettledWork();
        dedupeWork(queue, workKey);
        completeness.reconcileRetrying(queue.filter((item) => item.attempts > 0).length);
        if (queue.length === 0) {
          for (const spaceKey of remaining.keys()) {
            if (!settled.has(spaceKey)) failOpenTerminal(spaceKey);
          }
          keepDraining = false;
          break;
        }
      }
      const finished = completeness.snapshot();
      if (
        remaining.size === 0 &&
        inventorySpacesClassified(finished) >= finished.expected &&
        (finished.retrying ?? 0) === 0
      ) {
        completeness.markScanFinished();
        await persistCheckpoint({ drainFinished: true });
      } else {
        await persistCheckpoint();
      }
      const done = emitDone && completeness.snapshot().complete;
      return snapshot(done ? 'done' : 'batch');
    } finally {
      await this.jobStore.releaseDrain(jobId);
    }
  }

  private queueOrFailRetry<T extends DeferredWork>(
    completeness: InventoryCompletenessTracker,
    item: T,
    failure: 'unavailable' | 'rate_limited' | 'rejected',
    queue: DeferredWork[],
    counts: InventorySourceCounts,
    retryAfterMs?: number,
    onTerminal?: () => void,
    vaultKey?: string,
  ): void {
    if (item.attempts === 0) completeness.queueRetry();
    item.attempts += 1;
    const cap = failure === 'rate_limited' ? maxRateLimitAttempts : maxRejectedAttempts;
    if (item.attempts < cap) {
      item.notBefore =
        this.now() +
        retryDelayMs({
          attempt: item.attempts,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      if (vaultKey) {
        void this.jobStore.setVaultGate(vaultKey, item.notBefore);
      }
      upsertWork(queue, item, (existing) =>
        inventoryTaskKey(existing, vaultKey ?? inventoryVaultKey(existing, '')),
      );
      return;
    }
    completeness.failRetry(retryClassFromFailure(failure));
    counts.failed += 1;
    onTerminal?.();
  }

  private async resolveCall(
    sourceEName: string,
    sourceEVaultUri: string,
    source: Envelope,
  ): Promise<Envelope | undefined> {
    if (source.parsed.isReference !== true) return source;
    const owner = optionalString(source.parsed.canonicalOwnerEName);
    const id = optionalString(source.parsed.canonicalEnvelopeId);
    if (!owner || !id || !isEName(owner)) return undefined;
    const vault =
      owner === sourceEName
        ? { ownerEName: sourceEName, eVaultUri: sourceEVaultUri }
        : await this.resolveEVault(owner);
    return this.readEnvelope(vault.ownerEName, vault.eVaultUri, id);
  }

  /**
   * A trusted chat-reference chain can grant access to that group's video
   * messages, call recordings, and ordinary video File envelopes. Historical
   * message authors are followed even when they are no longer current members.
   * Bulk group-file listing stays membership-gated so unauthorized vault files
   * are never enumerated. Read each group once so multiple references cannot
   * multiply eVault traffic or cards.
   */
  private async discoverGroupVideos(
    viewerEName: string,
    chatReferences: ChatReference[],
    referenced: Set<string>,
    historicalAuthors: ReadonlyMap<string, ReadonlySet<string>>,
    completeness: InventoryCompletenessTracker,
    options?: {
      rateLimit?: RateLimitMode;
      onSpace?: () => void;
      onSpaceFailure?: () => void;
    },
  ): Promise<GroupDiscovery> {
    const chatsByGroup = new Map<string, Set<string>>();
    for (const reference of chatReferences) {
      if (reference.type && reference.type !== 'group') continue;
      const chatIds = chatsByGroup.get(reference.groupEName) ?? new Set<string>();
      chatIds.add(reference.chatId);
      chatsByGroup.set(reference.groupEName, chatIds);
    }

    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messageRecords: MeshengerMessage[] = [];
    const groups = [...chatsByGroup];
    await mapPool(groups, sharedSpaceConcurrency, async ([groupEName, chatIds]) => {
      completeness.expectSpace();
      const space = await this.readGroupSpace({
        viewerEName,
        groupEName,
        chatIds,
        referenced,
        historicalAuthors,
        completeness,
        ...(options?.rateLimit ? { rateLimit: options.rateLimit } : {}),
      });
      videos.push(...space.videos);
      conversations.push(...space.conversations);
      messageRecords.push(...space.messages);
      this.recordSpaceOutcome(completeness, space);
      if (space.outcome === 'retry') options?.onSpaceFailure?.();
      else options?.onSpace?.();
    });
    return {
      videos,
      conversations,
      messages: messageRecords,
      outcome: 'indexed',
      retryNeeded: false,
    };
  }

  private async readGroupSpace(input: {
    viewerEName: string;
    groupEName: string;
    chatIds: ReadonlySet<string>;
    referenced: Set<string>;
    historicalAuthors: ReadonlyMap<string, ReadonlySet<string>>;
    completeness: InventoryCompletenessTracker;
    rateLimit?: RateLimitMode;
    silenceRetries?: boolean;
    mode?: 'open' | 'full';
  }): Promise<GroupDiscovery> {
    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messageRecords: MeshengerMessage[] = [];
    const pendingAuthors: Array<{ authorEName: string; chatId: string }> = [];
    const failureTracker = input.silenceRetries ? undefined : input.completeness;
    const vaultRead = await this.readSource(
      () => this.resolveEVault(input.groupEName),
      undefined,
      failureTracker,
    );
    if (!vaultRead.value) {
      return emptySpace(
        vaultRead.failure === 'denied'
          ? 'denied'
          : vaultRead.failure === 'missing'
            ? 'missing'
            : 'retry',
        retryClassFromOptionalFailure(vaultRead.failure),
      );
    }
    const vault = vaultRead.value;
    const owner = vault.ownerEName;
    const groupEVaultUri = vault.eVaultUri;

    if (input.mode === 'open') {
      const manifestsRead = await this.readSource(
        () =>
          this.listEnvelopes(owner, groupEVaultUri, groupManifestOntology, undefined, {
            maxPages: 1,
            rateLimit: 'fail-fast',
          }),
        { items: [] as Envelope[], complete: false },
      );
      if (manifestsRead.failure === 'denied') return emptySpace('denied');
      if (manifestsRead.failure === 'missing') return emptySpace('missing');
      if (isRetryFailure(manifestsRead.failure)) {
        return emptySpace(
          'retry',
          retryClassFromOptionalFailure(manifestsRead.failure),
          manifestsRead.retryAfterMs,
        );
      }
      const currentManifest = manifestsRead.value.items.find((item) =>
        isCurrentGroupMember(item.parsed, input.viewerEName),
      );
      const manifest = currentManifest ?? manifestsRead.value.items[0];
      const currentMember = Boolean(currentManifest);
      if (manifest && currentMember) {
        const participantCount = groupParticipantCount(manifest.parsed);
        const role = groupRole(manifest.parsed, input.viewerEName);
        const updatedAt = optionalString(manifest.parsed.updatedAt);
        for (const chatId of input.chatIds) {
          conversations.push({
            id: `${input.groupEName}:${chatId}`,
            ownerEName: input.groupEName,
            chatId,
            kind: 'group',
            title: optionalString(manifest.parsed.name) ?? 'Group',
            ...(participantCount ? { participantCount } : {}),
            ...(role ? { role } : {}),
            ...(updatedAt ? { updatedAt } : {}),
          });
        }
      }
      const chatsRead = await this.readSource(
        () =>
          this.listEnvelopes(owner, groupEVaultUri, chatOntology, undefined, {
            maxPages: 1,
            rateLimit: 'fail-fast',
          }),
        { items: [] as Envelope[], complete: false },
      );
      if (chatsRead.failure === 'denied') return emptySpace('denied');
      if (chatsRead.failure === 'missing') return emptySpace('missing');
      if (isRetryFailure(chatsRead.failure)) {
        return emptySpace(
          'retry',
          retryClassFromOptionalFailure(chatsRead.failure),
          chatsRead.retryAfterMs,
        );
      }
      const openedChatIds = currentMember
        ? chatsRead.value.items.map((chat) => optionalString(chat.parsed.id) ?? chat.id)
        : [...input.chatIds];
      return {
        videos: [],
        conversations,
        messages: [],
        outcome: 'indexed',
        retryNeeded: false,
        vault,
        currentMember,
        openedChatIds,
        chatsComplete: chatsRead.value.complete,
        ...(chatsRead.value.endCursor ? { chatsCursor: chatsRead.value.endCursor } : {}),
        manifestsComplete: manifestsRead.value.complete,
        ...(manifestsRead.value.endCursor
          ? { manifestsCursor: manifestsRead.value.endCursor }
          : {}),
      };
    }

    const manifests = await this.tryListEnvelopes(
      owner,
      groupEVaultUri,
      groupManifestOntology,
      failureTracker,
      input.rateLimit ?? 'fail-fast',
    );
    const currentManifest = manifests.find((item) =>
      isCurrentGroupMember(item.parsed, input.viewerEName),
    );
    const manifest = currentManifest ?? manifests[0];
    const currentMember = Boolean(currentManifest);
    if (manifest && currentMember) {
      const participantCount = groupParticipantCount(manifest.parsed);
      const role = groupRole(manifest.parsed, input.viewerEName);
      const updatedAt = optionalString(manifest.parsed.updatedAt);
      for (const chatId of input.chatIds) {
        conversations.push({
          id: `${input.groupEName}:${chatId}`,
          ownerEName: input.groupEName,
          chatId,
          kind: 'group',
          title: optionalString(manifest.parsed.name) ?? 'Group',
          ...(participantCount ? { participantCount } : {}),
          ...(role ? { role } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        });
      }
    }

    const groupChats = await this.tryListEnvelopes(
      owner,
      groupEVaultUri,
      chatOntology,
      failureTracker,
      input.rateLimit ?? 'fail-fast',
    );
    const messageSources = new Set<string>([input.groupEName, owner]);
    if (currentManifest) {
      for (const member of groupMemberENames(currentManifest.parsed)) messageSources.add(member);
    }
    for (const chat of groupChats) {
      const chatId = optionalString(chat.parsed.id) ?? chat.id;
      if (!input.chatIds.has(chatId)) continue;
      for (const participant of asArray(chat.parsed.participantIds)) {
        if (typeof participant !== 'string') continue;
        const participantEName = normalizeEName(participant);
        if (isEName(participantEName)) messageSources.add(participantEName);
      }
    }
    for (const chatId of input.chatIds) {
      for (const author of input.historicalAuthors.get(chatId) ?? []) messageSources.add(author);
    }

    const callsRead = await this.readSource(
      () =>
        this.listEnvelopes(owner, groupEVaultUri, callSessionOntology, failureTracker, {
          rateLimit: input.rateLimit ?? 'fail-fast',
        }).then((page) => page.items),
      [] as Envelope[],
      failureTracker,
    );
    let retryNeeded = false;
    let scopedDenied = false;
    let scopedMissing = false;
    if (callsRead.failure === 'denied') scopedDenied = true;
    else if (callsRead.failure === 'missing') scopedMissing = true;
    else if (isRetryFailure(callsRead.failure)) retryNeeded = true;
    else {
      videos.push(
        ...(await this.discoverCallVideos({
          viewerEName: input.viewerEName,
          sourceEName: input.groupEName,
          sourceEVaultUri: groupEVaultUri,
          calls: callsRead.value,
          chatIds: input.chatIds,
          referenced: input.referenced,
        })),
      );
    }

    let messagesOk = 0;
    for (const chatId of input.chatIds) {
      const messageRead = await this.readSource(
        () =>
          this.listMessagesForChat(
            owner,
            groupEVaultUri,
            chatId,
            failureTracker,
            input.rateLimit ?? 'fail-fast',
          ),
        { items: [] as Envelope[], complete: false },
        failureTracker,
      );
      if (messageRead.failure === 'denied') scopedDenied = true;
      else if (messageRead.failure === 'missing') scopedMissing = true;
      else if (isRetryFailure(messageRead.failure)) retryNeeded = true;
      else {
        messagesOk += 1;
        videos.push(
          ...this.discoverMessageVideos(
            messageRead.value.items,
            input.referenced,
            input.viewerEName,
            input.groupEName,
          ),
        );
        messageRecords.push(
          ...messageRead.value.items.map((message) =>
            toMeshengerMessage(input.groupEName, message),
          ),
        );
        for (const author of authorsFromMessages(messageRead.value.items).get(chatId) ?? []) {
          messageSources.add(author);
        }
      }
    }

    let outcome: SharedSpaceOutcome = 'indexed';
    const callOk = !callsRead.failure;
    if (retryNeeded) outcome = 'retry';
    else if (callOk || messagesOk > 0) outcome = 'indexed';
    else if (scopedDenied) outcome = 'denied';
    else if (scopedMissing) outcome = 'missing';

    for (const chatId of input.chatIds) {
      for (const authorEName of messageSources) {
        if (sameEName(authorEName, input.groupEName) || sameEName(authorEName, owner)) continue;
        if (sameEName(authorEName, input.viewerEName)) continue;
        const authorRead = await this.readSource(
          async () => {
            const authorVault = await this.resolveEVault(authorEName);
            const authorMessages = await this.listMessagesForChat(
              authorVault.ownerEName,
              authorVault.eVaultUri,
              chatId,
              failureTracker,
              input.rateLimit ?? 'fail-fast',
            );
            videos.push(
              ...this.discoverMessageVideos(
                authorMessages.items,
                input.referenced,
                input.viewerEName,
                authorEName,
              ),
            );
            messageRecords.push(
              ...authorMessages.items.map((message) => toMeshengerMessage(authorEName, message)),
            );
          },
          undefined,
          failureTracker,
        );
        if (isRetryFailure(authorRead.failure)) {
          retryNeeded = true;
          pendingAuthors.push({ authorEName, chatId });
        }
      }
    }

    if (currentMember) {
      const files = await this.tryListEnvelopes(
        owner,
        groupEVaultUri,
        fileOntology,
        failureTracker,
        input.rateLimit ?? 'fail-fast',
      );
      videos.push(...this.discoverFileVideos(owner, files, input.referenced, input.viewerEName));
      const rawFiles = await this.tryListEnvelopes(
        owner,
        groupEVaultUri,
        w3dsFileOntology,
        failureTracker,
        input.rateLimit ?? 'fail-fast',
      );
      videos.push(
        ...this.discoverRawFileVideos(owner, rawFiles, input.referenced, input.viewerEName),
      );
    }
    return {
      videos,
      conversations,
      messages: messageRecords,
      outcome,
      retryNeeded,
      ...(pendingAuthors.length ? { pendingAuthors } : {}),
      ...(retryNeeded ? { retryClass: 'rate_limited' as const } : {}),
    };
  }

  /**
   * Direct chat references are hosted on another person's vault, not a group
   * vault, so they have no GroupManifest. The reference itself is the
   * discovery grant; we still require that its canonical Chat exists and only
   * return messages and call recordings for that exact chat id.
   */
  private async discoverDirectChatMedia(
    viewerEName: string,
    references: ChatReference[],
    referenced: Set<string>,
    completeness: InventoryCompletenessTracker,
    options?: {
      rateLimit?: RateLimitMode;
      onSpace?: () => void;
      onSpaceFailure?: () => void;
    },
  ): Promise<GroupDiscovery> {
    const byOwner = new Map<string, Set<string>>();
    for (const reference of references) {
      if (reference.groupEName === viewerEName) continue;
      if (reference.type === 'group') continue;
      const chatIds = byOwner.get(reference.groupEName) ?? new Set<string>();
      chatIds.add(reference.chatId);
      byOwner.set(reference.groupEName, chatIds);
    }

    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messages: MeshengerMessage[] = [];
    const owners = [...byOwner];
    await mapPool(owners, sharedSpaceConcurrency, async ([ownerEName, chatIds]) => {
      completeness.expectSpace();
      const space = await this.readDirectSpace({
        viewerEName,
        ownerEName,
        chatIds,
        referenced,
        completeness,
        ...(options?.rateLimit ? { rateLimit: options.rateLimit } : {}),
      });
      videos.push(...space.videos);
      conversations.push(...space.conversations);
      messages.push(...space.messages);
      this.recordSpaceOutcome(completeness, space);
      if (space.outcome === 'retry') options?.onSpaceFailure?.();
      else options?.onSpace?.();
    });
    return { videos, conversations, messages, outcome: 'indexed', retryNeeded: false };
  }

  private async readDirectSpace(input: {
    viewerEName: string;
    ownerEName: string;
    chatIds: ReadonlySet<string>;
    referenced: Set<string>;
    completeness: InventoryCompletenessTracker;
    rateLimit?: RateLimitMode;
    silenceRetries?: boolean;
    mode?: 'open' | 'full';
  }): Promise<GroupDiscovery> {
    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messages: MeshengerMessage[] = [];
    const failureTracker = input.silenceRetries ? undefined : input.completeness;
    const vaultRead = await this.readSource(
      () => this.resolveEVault(input.ownerEName),
      undefined,
      failureTracker,
    );
    if (!vaultRead.value) {
      return emptySpace(
        vaultRead.failure === 'denied'
          ? 'denied'
          : vaultRead.failure === 'missing'
            ? 'missing'
            : 'retry',
        retryClassFromOptionalFailure(vaultRead.failure),
      );
    }
    const owner = vaultRead.value.ownerEName;
    const eVaultUri = vaultRead.value.eVaultUri;
    const chatsRead = await this.readSource(
      () =>
        this.listEnvelopes(owner, eVaultUri, chatOntology, undefined, {
          maxPages: input.mode === 'open' ? 1 : maxPages,
          rateLimit: input.rateLimit ?? 'fail-fast',
        }),
      { items: [] as Envelope[], complete: false },
      failureTracker,
    );
    if (chatsRead.failure === 'denied') return emptySpace('denied');
    if (chatsRead.failure === 'missing') return emptySpace('missing');
    if (isRetryFailure(chatsRead.failure)) {
      return emptySpace(
        'retry',
        retryClassFromOptionalFailure(chatsRead.failure),
        chatsRead.retryAfterMs,
      );
    }

    const canonicalChats = new Map<string, Envelope>();
    for (const chat of chatsRead.value.items) {
      if (chat.parsed.isReference === true) continue;
      if (optionalString(chat.parsed.type)?.toLowerCase() === 'group') continue;
      const chatId = optionalString(chat.parsed.id) ?? chat.id;
      if (input.chatIds.has(chatId)) canonicalChats.set(chatId, chat);
    }

    for (const [chatId, chat] of canonicalChats) {
      const participants = asArray(chat.parsed.participantIds).filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
      );
      const updatedAt = optionalString(chat.parsed.updatedAt);
      conversations.push({
        id: `${input.ownerEName}:${chatId}`,
        ownerEName: input.ownerEName,
        chatId,
        kind: 'personal',
        title: optionalString(chat.parsed.name) ?? 'Conversation',
        ...(participants.length ? { participantCount: participants.length } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      });
    }

    if (input.mode === 'open') {
      return {
        videos: [],
        conversations,
        messages: [],
        outcome: 'indexed',
        retryNeeded: false,
        vault: vaultRead.value,
        openedChatIds: [...new Set([...input.chatIds, ...canonicalChats.keys()])],
        chatsComplete: chatsRead.value.complete,
        ...(chatsRead.value.endCursor ? { chatsCursor: chatsRead.value.endCursor } : {}),
      };
    }

    let retryNeeded = false;
    let retryClass: 'unavailable' | 'rate_limited' | 'rejected' | undefined;
    for (const chatId of input.chatIds) {
      const messageRead = await this.readSource(
        () =>
          this.listMessagesForChat(
            owner,
            eVaultUri,
            chatId,
            failureTracker,
            input.rateLimit ?? 'fail-fast',
          ),
        { items: [] as Envelope[], complete: false },
        failureTracker,
      );
      if (isRetryFailure(messageRead.failure)) {
        retryNeeded = true;
        retryClass = messageRead.failure;
      }
      if (messageRead.failure === 'denied' || messageRead.failure === 'missing') continue;
      videos.push(
        ...this.discoverMessageVideos(
          messageRead.value.items,
          input.referenced,
          input.viewerEName,
          input.ownerEName,
        ),
      );
      messages.push(
        ...messageRead.value.items.map((message) => toMeshengerMessage(input.ownerEName, message)),
      );
    }

    const callsRead = await this.readSource(
      () =>
        this.listEnvelopes(owner, eVaultUri, callSessionOntology, failureTracker, {
          rateLimit: input.rateLimit ?? 'fail-fast',
        }).then((page) => page.items),
      [] as Envelope[],
      failureTracker,
    );
    if (isRetryFailure(callsRead.failure)) {
      retryNeeded = true;
      retryClass = callsRead.failure;
    } else if (!callsRead.failure) {
      videos.push(
        ...(await this.discoverCallVideos({
          viewerEName: input.viewerEName,
          sourceEName: input.ownerEName,
          sourceEVaultUri: eVaultUri,
          calls: callsRead.value,
          chatIds: input.chatIds,
          referenced: input.referenced,
        })),
      );
    }

    return {
      videos,
      conversations,
      messages,
      outcome: retryNeeded ? 'retry' : 'indexed',
      retryNeeded,
      ...(retryClass ? { retryClass } : {}),
    };
  }

  private async discoverCallVideos({
    viewerEName,
    sourceEName,
    sourceEVaultUri,
    calls,
    chatId,
    chatIds,
    referenced,
  }: {
    viewerEName: string;
    sourceEName: string;
    sourceEVaultUri: string;
    calls: Envelope[];
    chatId?: string;
    chatIds?: ReadonlySet<string>;
    referenced: Set<string>;
  }): Promise<DiscoveredVideo[]> {
    const resolved: Envelope[] = [];
    for (const source of calls) {
      const callRead = await this.readSource(
        () => this.resolveCall(sourceEName, sourceEVaultUri, source),
        undefined,
      );
      if (callRead.value) resolved.push(callRead.value);
    }
    return discoverCallRecordingVideos({
      viewerEName,
      sourceEName,
      calls: resolved,
      referenced,
      ...(chatId ? { chatId } : {}),
      ...(chatIds ? { chatIds } : {}),
    });
  }

  private discoverMessageVideos(
    messages: Envelope[],
    referenced: Set<string>,
    viewerEName: string,
    sourceSpaceKey?: string,
    completeness?: InventoryCompletenessTracker,
    onResolve?: (fileUri: string, envelopeId: string) => void,
  ): DiscoveredVideo[] {
    const accepted: Envelope[] = [];
    for (const message of messages) {
      completeness?.recordCandidate();
      const decision = classifyAuthorizedMedia({
        payload: message.parsed,
        ...(sourceSpaceKey ? { vaultOwnerEName: sourceSpaceKey } : {}),
      });
      if (decision.status === 'accept') {
        completeness?.recordAccepted();
        accepted.push(message);
        continue;
      }
      if (decision.status === 'exclude') {
        completeness?.recordExcludedNonVideo();
        continue;
      }
      if (decision.status === 'resolve') {
        onResolve?.(decision.fileUri, message.id);
        continue;
      }
      const type = optionalString(message.parsed.type)?.toLowerCase();
      if (
        onResolve &&
        (type === 'file' || type === 'video' || type === 'circle' || !type) &&
        decision.reason === 'missing_w3ds_file_uri'
      ) {
        onResolve('', message.id);
        continue;
      }
      completeness?.recordUnresolved(decision.reason);
    }
    return discoverVideoMessageVideos(accepted, referenced, viewerEName, sourceSpaceKey);
  }

  private async resolveQueuedMedia(
    item: {
      fileUri: string;
      envelopeId?: string;
      owner: string;
      eVaultUri: string;
      vaultKey: string;
      sourceSpaceKey: string;
      attempts: number;
      notBefore?: number;
      retryAfterMs?: number;
    },
    found: DiscoveredVideo[],
    referenced: Set<string>,
    viewerEName: string,
    completeness: InventoryCompletenessTracker,
    queue: DeferredWork[],
    counts: InventorySourceCounts,
  ): Promise<void> {
    const parsedFile = parseW3dsFileUri(item.fileUri);
    const envelopeId = parsedFile?.metaEnvelopeId ?? item.envelopeId;
    const ownerHint = parsedFile?.ownerEName ?? item.owner;
    if (!envelopeId) {
      completeness.recordUnresolved('missing_w3ds_file_uri');
      return;
    }
    const vaultRead = await this.readSource(async () => {
      const vault =
        ownerHint === item.owner && item.eVaultUri
          ? { ownerEName: item.owner, eVaultUri: item.eVaultUri }
          : await this.resolveEVault(ownerHint);
      const envelope = await this.readEnvelope(vault.ownerEName, vault.eVaultUri, envelopeId);
      return { vault, envelope };
    }, undefined);
    if (vaultRead.failure === 'denied') {
      completeness.recordUnresolved('resolver_denied');
      return;
    }
    if (vaultRead.failure === 'missing') {
      completeness.recordUnresolved('resolver_missing');
      return;
    }
    if (isRetryFailure(vaultRead.failure) || !vaultRead.value) {
      this.queueOrFailRetry(
        completeness,
        item,
        vaultRead.failure && isRetryFailure(vaultRead.failure) ? vaultRead.failure : 'unavailable',
        queue,
        counts,
        vaultRead.retryAfterMs,
        () => completeness.recordUnresolved('resolver_unavailable'),
        parsedFile?.ownerEName ?? item.owner,
      );
      return;
    }
    if (item.attempts > 0) completeness.finishRetry();
    const resolved = vaultRead.value.envelope;
    const nested = classifyAuthorizedMedia({
      payload: resolved.parsed,
      vaultOwnerEName: vaultRead.value.vault.ownerEName,
    });
    if (!parsedFile && (nested.status === 'resolve' || nested.status === 'accept')) {
      const nestedParsed = parseW3dsFileUri(nested.fileUri);
      if (nestedParsed && nestedParsed.metaEnvelopeId !== envelopeId) {
        await this.resolveQueuedMedia(
          {
            ...item,
            fileUri: nested.fileUri,
            envelopeId: nestedParsed.metaEnvelopeId,
            owner: nestedParsed.ownerEName,
            eVaultUri: '',
            vaultKey: nestedParsed.ownerEName,
            attempts: 0,
          },
          found,
          referenced,
          viewerEName,
          completeness,
          queue,
          counts,
        );
        return;
      }
    }
    const fileUri =
      nested.status === 'accept' || nested.status === 'resolve'
        ? nested.fileUri
        : parsedFile
          ? item.fileUri
          : '';
    if (!fileUri || !parseW3dsFileUri(fileUri)) {
      completeness.recordUnresolved('missing_w3ds_file_uri');
      return;
    }
    const decision = classifyResolvedEnvelope({
      fileUri,
      payload: resolved.parsed,
      ontology: resolved.ontology,
    });
    if (decision.status === 'accept') {
      completeness.recordAccepted();
      found.push(
        ...discoverVideoMessageVideos(
          [
            {
              id: resolved.id,
              ontology: messageOntology,
              parsed: {
                type: 'file',
                mediaUri: decision.fileUri,
                ...resolved.parsed,
              },
            },
          ],
          referenced,
          viewerEName,
          item.sourceSpaceKey,
        ),
      );
      return;
    }
    if (decision.status === 'exclude') completeness.recordExcludedNonVideo();
    else if (decision.status === 'unresolved') completeness.recordUnresolved(decision.reason);
    else completeness.recordUnresolved('resolver_unavailable');
  }

  private discoverFileVideos(
    ownerEName: string,
    files: Envelope[],
    referenced: Set<string>,
    viewerEName: string,
  ): DiscoveredVideo[] {
    return discoverFileRecordVideos(ownerEName, files, referenced, viewerEName);
  }

  /** Discovers authorised video directly from the W3DS uploadFile record. */
  private discoverRawFileVideos(
    ownerEName: string,
    files: Envelope[],
    referenced: Set<string>,
    viewerEName: string,
  ): DiscoveredVideo[] {
    return discoverW3dsFileVideos(ownerEName, files, referenced, viewerEName);
  }

  private recordSpaceOutcome(completeness: InventoryCompletenessTracker, space: GroupDiscovery) {
    if (space.outcome === 'indexed') completeness.indexSpace();
    else if (space.outcome === 'denied') completeness.denySpace();
    else if (space.outcome === 'missing') completeness.missSpace();
    else completeness.markRetry();
    if (space.retryNeeded) completeness.markRetry();
  }

  private async tryListEnvelopes(
    owner: string,
    eVaultUri: string,
    ontologyId: string,
    completeness?: InventoryCompletenessTracker,
    rateLimit: RateLimitMode = 'fail-fast',
  ): Promise<Envelope[]> {
    return (
      await this.readSource(
        () => this.listEnvelopes(owner, eVaultUri, ontologyId, completeness, { rateLimit }),
        { items: [] as Envelope[], complete: true },
        completeness,
      )
    ).value.items;
  }

  private async readSource<T>(
    read: () => Promise<T>,
    fallback: T,
    completeness?: InventoryCompletenessTracker,
  ): Promise<{ value: T; failure?: SourceFailure; retryAfterMs?: number }> {
    try {
      return { value: await read() };
    } catch (error) {
      const kind = sourceFailureClass(error);
      if (kind === 'fatal') throw error;
      if (isRetryFailure(kind)) completeness?.markRetryClass(retryClassFromFailure(kind));
      return {
        value: fallback,
        failure: kind,
        ...(error instanceof MeshengerVideoLibraryError && error.retryAfterMs !== undefined
          ? { retryAfterMs: error.retryAfterMs }
          : {}),
      };
    }
  }

  private async listEnvelopes(
    owner: string,
    eVaultUri: string,
    ontologyId: string,
    completeness?: InventoryCompletenessTracker,
    options?: { maxPages?: number; after?: string | null; rateLimit?: RateLimitMode },
  ): Promise<{ items: Envelope[]; complete: boolean; endCursor?: string }> {
    const page = await collectPaginatedEnvelopes({
      maxPages: options?.maxPages ?? maxPages,
      ...(options?.after !== undefined ? { after: options.after } : {}),
      readPage: async (after) => {
        const data = await this.graphql(
          owner,
          eVaultUri,
          listQuery,
          {
            ontologyId,
            first: pageSize,
            after,
          },
          options?.rateLimit ?? 'fail-fast',
        );
        return record(data.metaEnvelopes);
      },
      mapEdge: envelopeFromEdge,
    });
    if (!page.complete) completeness?.markRetry();
    return page;
  }

  /** Query a single chat on one author vault; never enumerate that vault's unrelated messages. */
  private async listMessagesForChat(
    owner: string,
    eVaultUri: string,
    chatId: string,
    completeness?: InventoryCompletenessTracker,
    rateLimit: RateLimitMode = 'fail-fast',
    options?: { maxPages?: number; after?: string | null },
  ): Promise<{ items: Envelope[]; complete: boolean; endCursor?: string }> {
    const page = await collectPaginatedEnvelopes({
      maxPages: options?.maxPages ?? maxPages,
      ...(options?.after !== undefined ? { after: options.after } : {}),
      readPage: async (after) => {
        const data = await this.graphql(
          owner,
          eVaultUri,
          chatMessagesQuery,
          {
            ontologyId: messageOntology,
            chatId,
            first: pageSize,
            after,
          },
          rateLimit,
        );
        return record(data.metaEnvelopes);
      },
      mapEdge: envelopeFromEdge,
    });
    if (!page.complete) completeness?.markRetry();
    return page;
  }

  private async readEnvelope(owner: string, eVaultUri: string, id: string): Promise<Envelope> {
    const data = await this.graphql(owner, eVaultUri, readQuery, { id });
    const node = record(data.metaEnvelope);
    const envelopeId = optionalString(node?.id);
    const ontology = optionalString(node?.ontology);
    const parsed = mergeDocumentedEnvelopeFields(
      parsePayload(node?.parsed) ?? {},
      asArray(node?.envelopes),
    );
    if (!envelopeId || !ontology || Object.keys(parsed).length === 0)
      throw new MeshengerVideoLibraryError(
        'The eVault returned an invalid video record.',
        'remote_rejected',
        502,
      );
    return { id: envelopeId, ontology, parsed };
  }

  private async resolveEVault(eName: string): Promise<ResolvedVault> {
    const requested = normalizeEName(eName);
    const url = new URL('/resolve', this.config.registryBaseUrl);
    url.searchParams.set('w3id', requested);
    const resolved = record(await this.requestJson(url, { method: 'GET' }));
    const uri = optionalString(resolved?.uri);
    if (!uri) {
      throw new MeshengerVideoLibraryError(
        'The W3DS registry could not resolve this video source.',
        'remote_rejected',
        502,
      );
    }
    const resolvedEName = optionalString(resolved?.ename);
    const ownerEName = resolvedEName ? normalizeEName(resolvedEName) : requested;
    if (!isEName(ownerEName)) {
      throw new MeshengerVideoLibraryError(
        'The W3DS registry could not resolve this video source.',
        'remote_rejected',
        502,
      );
    }
    return { ownerEName, eVaultUri: httpUrl(uri) };
  }

  private async graphql(
    owner: string,
    eVaultUri: string,
    query: string,
    variables: Record<string, unknown>,
    rateLimit: RateLimitMode = 'fail-fast',
  ): Promise<RecordValue> {
    const platformToken = await this.getPlatformToken();
    const body = record(
      await this.requestJson(
        new URL('/graphql', eVaultUri),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-ENAME': owner,
            Authorization: `Bearer ${platformToken}`,
          },
          body: JSON.stringify({ query, variables }),
        },
        rateLimit,
      ),
    );
    const data = record(body?.data);
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    if (errors.length && !data) throw graphqlErrorsToLibraryError(errors);
    if (!data)
      throw new MeshengerVideoLibraryError(
        'The eVault returned invalid data.',
        'remote_rejected',
        502,
      );
    return data;
  }

  /** Registry-issued token used by the documented W3DS Web3 Adapter flow. */
  private async getPlatformToken(): Promise<string> {
    if (!this.platformToken) {
      this.platformToken = this.requestPlatformToken();
    }
    try {
      return await this.platformToken;
    } catch (error) {
      this.platformToken = undefined;
      throw error;
    }
  }

  private async requestPlatformToken(): Promise<string> {
    const payload = record(
      await this.requestJson(new URL('/platforms/certification', this.config.registryBaseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: this.config.platformName }),
      }),
    );
    const token = optionalString(payload?.token);
    if (!token) {
      throw new MeshengerVideoLibraryError(
        'The W3DS registry did not issue a platform credential.',
        'remote_rejected',
        502,
      );
    }
    return token;
  }

  private async requestJson(
    url: URL,
    init: RequestInit,
    rateLimit: RateLimitMode = 'fail-fast',
  ): Promise<unknown> {
    const attempt = async (): Promise<unknown> => {
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          cache: 'no-store',
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch {
        throw new MeshengerVideoLibraryError(
          'The W3DS video source is unavailable.',
          'remote_unavailable',
          503,
        );
      }
      if (response.status === 429) {
        throw new MeshengerVideoLibraryError(
          'The W3DS video source is busy. Please try again shortly.',
          'rate_limited',
          429,
          parseRetryAfter(response.headers.get('Retry-After')),
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new MeshengerVideoLibraryError(
          'This video source is not available to this account.',
          'authorization_denied',
          403,
        );
      }
      if (response.status === 404) {
        throw new MeshengerVideoLibraryError('The video source was not found.', 'not_found', 404);
      }
      if (!response.ok)
        throw new MeshengerVideoLibraryError(
          'The W3DS video source rejected the request.',
          'remote_rejected',
          502,
        );
      try {
        return await response.json();
      } catch {
        throw new MeshengerVideoLibraryError(
          'The W3DS video source returned invalid data.',
          'remote_rejected',
          502,
        );
      }
    };
    if (rateLimit === 'fail-fast') return attempt();
    return retryWithExponentialBackoff(attempt, {
      isRetryable: (error) =>
        error instanceof MeshengerVideoLibraryError && error.code === 'rate_limited',
      maxAttempts: 4,
      baseMs: 250,
      capMs: 4_000,
      retryAfterMs: (error) =>
        error instanceof MeshengerVideoLibraryError ? error.retryAfterMs : undefined,
    });
  }
}

export function createMeshengerVideoLibrary(
  env: Record<string, string | undefined> = process.env,
  options?: { jobStore?: InventoryJobStore; now?: () => number },
): MeshengerVideoLibrary {
  const registry = env.W3DS_REGISTRY_BASE_URL?.trim();
  const signingSecret = env.W3DS_AUTH_JWT_SECRET;
  if (!registry || !signingSecret || signingSecret.length < 32) {
    throw new MeshengerVideoLibraryError(
      'eVault videos are not configured for this Vidak deployment.',
      'not_configured',
      503,
    );
  }
  return new MeshengerVideoLibrary(
    {
      registryBaseUrl: httpUrl(registry),
      platformName: env.W3DS_AUTH_PLATFORM_NAME?.trim() || 'vidak',
      signingSecret,
    },
    options,
  );
}

export function createMeshengerVideoStreamId(grant: StreamGrant, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

export function verifyMeshengerVideoStreamId(value: string, secret: string): StreamGrant {
  const [encoded, signature, ...rest] = value.split('.');
  if (!encoded || !signature || rest.length) invalidStream();
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  )
    invalidStream();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    invalidStream();
  }
  const grant = record(parsed);
  const eName = optionalString(grant?.eName);
  const fileUri = optionalString(grant?.fileUri);
  const expiresAt = number(grant?.expiresAt);
  if (
    !eName ||
    !fileUri ||
    expiresAt === undefined ||
    !isEName(eName) ||
    !parseW3dsFileUri(fileUri)
  )
    invalidStream();
  if (expiresAt <= Date.now())
    throw new MeshengerVideoLibraryError(
      'This video link has expired. Refresh the library and try again.',
      'stream_expired',
      401,
    );
  return { eName, fileUri, expiresAt };
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function emptySpace(
  outcome: SharedSpaceOutcome,
  retryClass?: 'unavailable' | 'rate_limited' | 'rejected',
  retryAfterMs?: number,
): GroupDiscovery {
  return {
    videos: [],
    conversations: [],
    messages: [],
    outcome,
    retryNeeded: outcome === 'retry',
    ...(retryClass ? { retryClass } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}
function sourceFailureClass(error: unknown): SourceFailure | 'fatal' {
  if (error instanceof MeshengerVideoLibraryError) {
    if (error.code === 'authentication_required' || error.code === 'not_configured') return 'fatal';
    if (error.code === 'authorization_denied') return 'denied';
    if (error.code === 'not_found') return 'missing';
    if (error.code === 'remote_unavailable') return 'unavailable';
    if (error.code === 'rate_limited') return 'rate_limited';
    return 'rejected';
  }
  return 'rejected';
}
function isRetryFailure(
  kind: SourceFailure | undefined,
): kind is 'unavailable' | 'rate_limited' | 'rejected' {
  return kind === 'unavailable' || kind === 'rate_limited' || kind === 'rejected';
}
function retryClassFromFailure(
  kind: 'unavailable' | 'rate_limited' | 'rejected',
): 'unavailable' | 'rejected' | 'rate_limited' {
  return kind;
}
function retryClassFromOptionalFailure(
  kind: SourceFailure | undefined,
): 'unavailable' | 'rate_limited' | 'rejected' | undefined {
  return isRetryFailure(kind) ? kind : undefined;
}
function mergeAuthorMap(target: Map<string, Set<string>>, extra: Map<string, Set<string>>): void {
  for (const [chatId, authors] of extra) {
    const existing = target.get(chatId) ?? new Set<string>();
    for (const author of authors) existing.add(author);
    target.set(chatId, existing);
  }
}
function graphqlErrorsToLibraryError(errors: unknown[]): MeshengerVideoLibraryError {
  if (errors.some((error) => isAuthorizationGraphqlError(error))) {
    return new MeshengerVideoLibraryError(
      'This video source is not available to this account.',
      'authorization_denied',
      403,
    );
  }
  return new MeshengerVideoLibraryError(
    'The eVault rejected the video-library request.',
    'remote_rejected',
    502,
  );
}
function isAuthorizationGraphqlError(error: unknown): boolean {
  const value = record(error);
  const code = String(value?.code ?? record(value?.extensions)?.code ?? '').toUpperCase();
  const message = String(value?.message ?? '').toLowerCase();
  return (
    code.includes('FORBIDDEN') ||
    code.includes('UNAUTHENTICATED') ||
    code.includes('UNAUTHORIZED') ||
    code.includes('ACL') ||
    message.includes('forbidden') ||
    message.includes('unauthorized') ||
    message.includes('unauthenticated') ||
    message.includes('access denied')
  );
}
function recordCoveragePage(
  completeness: InventoryCompletenessTracker | undefined,
  ontologyId: string,
): void {
  const kind = coverageKindForOntology(ontologyId);
  if (kind) completeness?.recordPage(kind);
}
function normalizeEName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}
function sameEName(left: string, right: string): boolean {
  return normalizeEName(left) === normalizeEName(right);
}
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function chatGrantFromEnvelope(envelope: Envelope, viewerEName: string): ChatReference[] {
  const payload = envelope.parsed;
  const type = optionalString(payload.type)?.toLowerCase();
  const chatId =
    optionalString(payload.canonicalChatId) ?? optionalString(payload.id) ?? envelope.id;
  if (!chatId) return [];
  if (payload.isReference === true) {
    const owner = optionalString(payload.canonicalOwnerEName);
    const ownerEName = owner ? asEName(owner) : undefined;
    if (!ownerEName) return [];
    return [{ groupEName: ownerEName, chatId, basis: 'reference', ...(type ? { type } : {}) }];
  }
  const grants: ChatReference[] = [];
  const canonicalOwner = optionalString(payload.canonicalOwnerEName);
  const canonicalOwnerEName = canonicalOwner ? asEName(canonicalOwner) : undefined;
  if (canonicalOwnerEName && !sameEName(canonicalOwnerEName, viewerEName)) {
    grants.push({
      groupEName: canonicalOwnerEName,
      chatId,
      basis: 'official',
      ...(type ? { type } : {}),
    });
  }
  if (type === 'group') return grants;
  for (const participant of asArray(payload.participantIds)) {
    if (typeof participant !== 'string') continue;
    const participantEName = asEName(participant);
    if (!participantEName || sameEName(participantEName, viewerEName)) continue;
    grants.push({
      groupEName: participantEName,
      chatId,
      type: type ?? 'direct',
      basis: 'official',
    });
  }
  return grants;
}
function chatGrantsFromEnvelopes(envelopes: Envelope[], viewerEName: string): ChatReference[] {
  const unique = new Map<string, ChatReference>();
  for (const envelope of envelopes) {
    for (const grant of chatGrantFromEnvelope(envelope, viewerEName)) {
      unique.set(`${grant.groupEName}::${grant.chatId}::${grant.type ?? ''}`, grant);
    }
  }
  return [...unique.values()];
}
function chatEnvelopesToConversations(
  ownerEName: string,
  chatReferences: ChatReference[],
  envelopes: Envelope[],
): MeshengerConversation[] {
  const referencedGroups = new Set(
    chatReferences.map((reference) => `${reference.groupEName}::${reference.chatId}`),
  );
  return envelopes.flatMap((envelope) => {
    if (envelope.parsed.isReference === true) return [];
    const chatId = optionalString(envelope.parsed.id) ?? envelope.id;
    const canonicalOwner = optionalString(envelope.parsed.canonicalOwnerEName) ?? ownerEName;
    if (referencedGroups.has(`${canonicalOwner}::${chatId}`)) return [];
    const participantIds = asArray(envelope.parsed.participantIds).filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    );
    const updatedAt = optionalString(envelope.parsed.updatedAt);
    return [
      {
        id: `${ownerEName}:${chatId}`,
        ownerEName,
        chatId,
        kind: 'personal',
        title: optionalString(envelope.parsed.name) ?? 'Conversation',
        ...(participantIds.length ? { participantCount: participantIds.length } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      },
    ];
  });
}
function toMeshengerMessage(ownerEName: string, envelope: Envelope): MeshengerMessage {
  const parsed = envelope.parsed;
  const chatId = optionalString(parsed.chatId);
  const senderEName = optionalString(parsed.senderEName);
  const content = optionalString(parsed.content);
  const replyToId = optionalString(parsed.replyTo);
  const createdAt = optionalString(parsed.createdAt);
  return {
    id: `${ownerEName}:${envelope.id}`,
    ownerEName,
    ...(chatId ? { chatId } : {}),
    type: optionalString(parsed.type) ?? 'message',
    ...(senderEName ? { senderEName } : {}),
    ...(content ? { content } : {}),
    ...(replyToId ? { replyToId } : {}),
    ...(createdAt ? { createdAt } : {}),
    edited: parsed.edited === true,
  };
}
function uniqueConversations(items: MeshengerConversation[]): MeshengerConversation[] {
  const unique = new Map<string, MeshengerConversation>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
function uniqueMessages(items: MeshengerMessage[]): MeshengerMessage[] {
  const unique = new Map<string, MeshengerMessage>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()];
}
function isCurrentGroupMember(payload: RecordValue, eName: string): boolean {
  return (
    optionalString(payload.owner) === eName ||
    asArray(payload.admins).some((member) => member === eName) ||
    asArray(payload.members).some((member) => member === eName)
  );
}
function groupRole(payload: RecordValue, eName: string): 'admin' | 'participant' | undefined {
  if (optionalString(payload.owner) === eName) return 'admin';
  if (asArray(payload.admins).some((member) => member === eName)) return 'admin';
  if (asArray(payload.members).some((member) => member === eName)) return 'participant';
  return undefined;
}
function groupParticipantCount(payload: RecordValue): number {
  const people = new Set<string>();
  const owner = optionalString(payload.owner);
  if (owner) people.add(owner);
  for (const member of [...asArray(payload.admins), ...asArray(payload.members)]) {
    if (typeof member === 'string' && member.trim()) people.add(member);
  }
  return people.size;
}
function envelopeFromEdge(edge: unknown): Envelope | undefined {
  const node = record(record(edge)?.node);
  const id = optionalString(node?.id);
  const ontology = optionalString(node?.ontology);
  const parsed = mergeDocumentedEnvelopeFields(
    parsePayload(node?.parsed) ?? {},
    asArray(node?.envelopes),
  );
  if (!id || !ontology) return undefined;
  if (Object.keys(parsed).length === 0) return undefined;
  return { id, ontology, parsed };
}

function authorsFromMessages(envelopes: readonly Envelope[]): Map<string, Set<string>> {
  const authors = new Map<string, Set<string>>();
  for (const envelope of envelopes) {
    const chatId = optionalString(envelope.parsed.chatId);
    const sender =
      optionalString(envelope.parsed.senderEName) ?? optionalString(envelope.parsed.senderId);
    if (!chatId || !sender) continue;
    const senderEName = normalizeEName(sender);
    if (!isEName(senderEName)) continue;
    const existing = authors.get(chatId) ?? new Set<string>();
    existing.add(senderEName);
    authors.set(chatId, existing);
  }
  return authors;
}

function groupMemberENames(payload: RecordValue): string[] {
  const people = new Set<string>();
  const owner = optionalString(payload.owner);
  if (owner) people.add(owner);
  for (const member of [...asArray(payload.admins), ...asArray(payload.members)]) {
    if (typeof member === 'string' && isEName(member)) people.add(member);
  }
  return [...people];
}

function parsePayload(value: unknown): RecordValue | undefined {
  if (record(value)) return record(value);
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}
function asEName(value: string): string | undefined {
  const normalized = normalizeEName(value);
  return isEName(normalized) ? normalized : undefined;
}
function isEName(value: string): boolean {
  return /^@[^\s@/]+$/.test(value);
}
function requireEName(value: string): string {
  if (!isEName(value))
    throw new MeshengerVideoLibraryError(
      'Authentication is required.',
      'authentication_required',
      401,
    );
  return value;
}
function invalidStream(): never {
  throw new MeshengerVideoLibraryError('The video link is invalid.', 'invalid_stream', 401);
}
function cacheMediaUrl(key: string, url: string, expiresAt: number): void {
  const now = Date.now();
  for (const [cachedKey, cached] of cachedMediaUrls) {
    if (cached.expiresAt <= now || cachedMediaUrls.size >= maxCachedMediaUrls)
      cachedMediaUrls.delete(cachedKey);
  }
  cachedMediaUrls.set(key, { url, expiresAt });
}
function httpUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
      throw new Error();
    return url.toString();
  } catch {
    throw new MeshengerVideoLibraryError(
      'The W3DS video source is misconfigured.',
      'not_configured',
      503,
    );
  }
}
function safeMediaUrl(value: string): string {
  const url = new URL(httpUrl(value));
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    throw new MeshengerVideoLibraryError(
      'The video source URL is unsafe.',
      'unsafe_media_url',
      502,
    );
  }
  return url.toString();
}

/** Reject literal private, loopback, link-local, and unroutable destinations before proxying. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b) || parts.some((part) => Number(part) > 255))
    return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  return (
    host === '::' ||
    host === '::1' ||
    /^fe[89ab][0-9a-f]:/.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  );
}
