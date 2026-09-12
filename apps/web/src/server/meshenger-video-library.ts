import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import 'server-only';

import type { AuthUser } from '@w3ds/auth';
import {
  type MeshengerPlaybackGrantConfig,
  type MeshengerPlaybackGrantResult,
  readMeshengerPlaybackGrantConfig,
  requestMeshengerPlaybackGrant,
} from './meshenger-playback-grant';
import {
  type DiscoveredVideoRecord,
  discoverCallRecordingVideos,
  discoverFileRecordVideos,
  discoverVideoMessageVideos,
  discoverW3dsFileVideos,
  type FileRecordReferenceTarget,
  fileRecordReferenceTarget,
  isAuthorizedCallParticipant,
  orderedRecordingFileUris,
  type VideoAccessBasis,
} from './video-space/adapters';
import {
  reserveInteractivePlayback,
  reserveInteractiveSourceWork,
  resetBackgroundWorkPriorityForTests,
} from './video-space/background-work-priority';
import { parseRetryAfter, retryDelayMs, retryWithExponentialBackoff } from './video-space/backoff';
import { assembleVideoSpaceCatalogue } from './video-space/catalogue';
import {
  hasCatalogueVersion,
  isStaleCatalogueVersion,
  VIDEO_SPACE_CATALOGUE_VERSION,
} from './video-space/catalogue-version';
import {
  completeInventory,
  createInventoryCompletenessTracker,
  type InventoryCompleteness,
  type InventoryCompletenessTracker,
  inventoryHasRateLimitedFalseComplete,
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
  type InventoryJobRecord,
  type InventoryJobStore,
} from './video-space/job-store';
import { mapPool } from './video-space/map-pool';
import {
  classifyAuthorizedMedia,
  classifyResolvedEnvelope,
  mergeDocumentedEnvelopeFields,
} from './video-space/media-eligibility';
import { collectPaginatedEnvelopes } from './video-space/pagination';
import {
  coalesceSharedAccessProbe,
  forgetVerifiedSharedAccess,
  hasVerifiedSharedAccess,
  rememberVerifiedSharedAccess,
} from './video-space/shared-access-cache';
import { isGenericVideoSpaceTitle } from './video-space/titles';
import {
  getViewerChatGrantPointerStore,
  setViewerChatGrantPointerStoreForTests,
  type ViewerChatGrantPointerStore,
} from './video-space/viewer-chat-grant-pointer-store';
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
// Canonical W3DS User ontology. Legacy Chat participantIds can contain a
// User envelope id (or the User body's `id`) instead of an eName. Resolving
// those forms is only safe through the known person's own eVault, never by a
// registry-wide identity search on the foreground playback path.
const userOntology = '550e8400-e29b-41d4-a716-446655440000';
const messageOntology = documentedOntologyId('video-message');
const fileOntology = documentedOntologyId('file-record');
const w3dsFileOntology = documentedOntologyId('w3ds-file');
const pageSize = 100;
const maxPages = 30;
const requestTimeoutMs = 12_000;
// A shared Watch authorization can otherwise spend one 12-second request on
// the indexed Chat query and another 12 seconds on each legacy-history page.
// Bound one interactive proof as a whole so a slow, inconclusive remote source
// becomes retryable instead of holding the player for roughly a minute. This
// is deliberately not an authorization decision: only a positive completed
// proof may open media, and a deadline is surfaced as a retryable 503.
const interactiveSharedProofTimeoutMs = 8_000;
// A fully-addressed CallSession card carries all three immutable identifiers
// needed for an exact proof. Keep its speculative shortcut short: on a source
// outage we return a retryable result instead of silently beginning the old
// multi-page history scan.
const interactiveExactSharedCallProofTimeoutMs = 2_500;
// Older eVaults can leave the indexed Chat lookup on a bounded legacy-history
// scan. Give the normal indexed path a brief head start, then ask for the
// known Chat envelope directly. The direct read is only a positive hedge: a
// miss, error, or non-member result always leaves the existing lookup and the
// viewer-vault grant path authoritative.
const interactiveDirectChatEnvelopeHedgeDelayMs = 250;
// A local pointer lookup is an optimization only. Do not turn a contended
// database into another foreground dependency: when this small budget expires
// the existing remote proof begins exactly as it did before the pointer index.
const viewerChatGrantPointerLookupBudgetMs = 25;
// A cached shared redirect still needs a current source proof after the
// positive-proof cache expires. Keep resumable inventory out of that bounded
// foreground check, with a small scheduling margin, without extending the
// pause for normal native-player Range requests that can reuse a proof.
const interactiveCachedSharedProofReservationMs = interactiveSharedProofTimeoutMs + 1_000;
// A source eVault address is only directory metadata, never permission. Keep
// it long enough to cover a realistic browsing session so every cold Watch
// does not repeat a slow registry lookup. If a cached destination reports a
// missing File, playback performs one fresh lookup before failing, so a moved
// eVault is not hidden by this cache.
const eVaultResolutionTtlMs = 5 * 60_000;
const maxCachedEVaultResolutions = 256;
// The canonical File redirect is a fast path. If an eVault is overloaded, do
// not let that optional attempt consume the whole interactive playback budget
// before the proven metadata fallback starts.
const directFileDereferenceTimeoutMs = 2_000;
const directFileFallbackTtlMs = 5 * 60_000;
// A network timeout is not proof that the endpoint is permanently absent, but
// retrying that optional fast path for every card makes a slow eVault feel
// progressively worse. Prefer the established GraphQL fallback briefly, then
// probe the direct endpoint again.
const directFileTransientFallbackTtlMs = 30_000;
// Discovery is resumable background work. A low per-wave eVault concurrency
// avoids making a shared recording compete with several history scans on the
// same source host when the service has only one CPU.
const sharedSpaceConcurrency = 2;
/** Fail-fast first, then Retry-After / exponential backoff until the page succeeds or is terminal. */
const maxRejectedAttempts = 4;
// Call recordings are stored as ~45-second files. A multi-hour recording must
// remain playable through its final segment, while the authenticated stream
// route still verifies the current user on every request.
const streamLifetimeMs = 4 * 60 * 60 * 1000;
const maxCachedMediaUrls = 256;
const maxRenewedStreams = 256;
// A cold Watch action may collide with the single resumable preview worker.
// Give the explicitly requested video a very short global head start; the
// longer reservation below remains eVault-scoped so it never pauses unrelated
// catalogue work.
const interactivePreviewReservationMs = 5_000;
// A single source may need several retry attempts to open. This is a
// vault-scoped gate for inventory work; unlike the short global preview
// reservation, it never pauses unrelated catalogue sources.
const interactiveVaultReservationMs = 90_000;
// The video library never needs to retain an unbounded copy of chat history.
// Keeping this small compatibility payload prevents a large eVault from turning
// an inventory checkpoint into a multi-hundred-megabyte JSON document.
const maxRetainedLibraryMessages = 128;
const maxRetainedLibraryConversations = 128;
const maxDeferredMetadataStringLength = 512;
const streamGrantVersion = 'v2';

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
  /** Safe source context for a shared card; never an eName or vault identity. */
  sharedVia?: 'group' | 'conversation';
  /** A source owner's explicitly chosen public Vidak name, when available. */
  sharedBy?: string;
  /** Safe UI state when a shared source is temporarily being rechecked. */
  sourceAccess?: 'checking';
  /** Server-only. Stripped before any client JSON. */
  sourceSpaceKey?: string;
  /** Server-only. Stripped before any client JSON. */
  sourceChatId?: string;
  /** Server-only current viewer Chat envelope for fast direct-share revalidation. */
  sourceViewerChatGrantId?: string;
  /** Server-only local File-reference envelope used for current authorization. */
  sourceReferenceId?: string;
  /** Server-only canonical File id that the reference must still target. */
  sourceReferenceFileId?: string;
  accessBasis?: VideoAccessBasis;
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
  /** Internal discovery context for a dereferenced canonical CallSession. */
  sourceCallSessionVault?: string;
}
interface StreamGrant {
  eName: string;
  fileUri: string;
  /** The catalogue classification at the time this private grant was issued. */
  accessScope: EVaultVideoAccessScope;
  /** Authorization context for a shared source; signed but never client-readable. */
  sourceSpaceKey?: string;
  sourceChatId?: string;
  sourceViewerChatGrantId?: string;
  /** Canonical CallSession context for an exact shared-recording proof. */
  sourceCallSessionId?: string;
  /** Canonical vault containing `sourceCallSessionId` and its source Chat. */
  sourceCallSessionVault?: string;
  /** Optional media-storage vault declared inside the CallSession recording. */
  sourceRecordingVault?: string;
  /** A direct Chat grant cannot substitute for current group membership. */
  sourceChatKind?: 'direct' | 'group';
  sourceReferenceId?: string;
  sourceReferenceFileId?: string;
  accessBasis?: VideoAccessBasis;
  expiresAt: number;
}
interface Config {
  registryBaseUrl: string;
  platformName: string;
  signingSecret: string;
  playbackGrantConfig?: MeshengerPlaybackGrantConfig;
}
interface CachedMediaUrl {
  url: string;
  expiresAt: number;
}
interface FastSharedCallPlayback {
  url: string;
  cacheHit: boolean;
}
interface RenewedStream {
  eName: string;
  streamId: string;
  expiresAt: number;
}
type DiscoveredVideo = DiscoveredVideoRecord;
interface ChatReference {
  groupEName: string;
  chatId: string;
  /** Exact Chat envelope just read in the viewer's own vault. */
  viewerChatGrantId?: string | undefined;
  type?: string | undefined;
  basis: 'reference' | 'official';
}
type SourceFailure = 'denied' | 'missing' | 'unavailable' | 'rate_limited' | 'rejected';
type RateLimitMode = 'fail-fast' | 'backoff';
// Interactive, ordinary background, cancellable hover warmups, and
// cancellable preview reads use the same proven retry behavior, but have
// separate pending operations. A Watch click must not wait for a background
// retry, and cancelling a best-effort hover/preview must not abort a request
// which the actual player is about to reuse.
type SourceReadPolicy =
  | RateLimitMode
  | 'interactive'
  | 'warmup-cancellable'
  | 'background-cancellable'
  // Durable inventory must be able to stop an in-flight eVault read for an
  // explicit Watch request. Keep its pending source work separate from both
  // foreground fail-fast work and interactive playback, while retaining the
  // normal one-attempt inventory semantics.
  | 'inventory-cancellable';
type ViewerIdentity = Pick<AuthUser, 'eName'> & Partial<Pick<AuthUser, 'eVaultUri'>>;
export type MediaResolutionPriority = 'background' | 'warmup' | 'interactive';

/**
 * Both an explicit Watch and its cancellable hover warmup are foreground
 * viewer intent. They may use a current, exact Chat envelope as a positive
 * shortcut, but background catalogue/preview work must retain the lighter
 * indexed lookup so it cannot turn a large grid into a source-read burst.
 */
function usesDirectChatEnvelopeFastPath(rateLimit: SourceReadPolicy): boolean {
  return rateLimit === 'interactive' || rateLimit === 'warmup-cancellable';
}

/**
 * Fixed, non-sensitive timings for one source-URL resolution. These expose no
 * eName, stream id, URL, or response data and are used only by the private
 * playback route's structured operational logs.
 */
export interface MediaResolutionTiming {
  mediaUrlCacheHit: boolean;
  sharedAccessVerificationMs: number;
  eVaultResolutionMs: number;
  directFileDereferenceMs: number;
  platformTokenMs: number;
  metadataReadMs: number;
}

/**
 * Fixed source-proof context for latency diagnostics. It deliberately omits
 * all viewer, stream, Chat, File, vault, and grant identifiers.
 */
export interface MediaAuthorizationTimingContext {
  accessBasis: 'personal' | 'membership' | 'history' | 'reference';
  proofKind: 'personal' | 'group' | 'direct_group' | 'reference';
  /** The per-proof interactive deadline; zero when no deadline applies. */
  sharedProofDeadlineMs: number;
  /** Whether this stream carries an exact current viewer Chat-grant hint. */
  viewerChatGrantHint: boolean;
}

export interface MediaResolutionOptions {
  priority?: MediaResolutionPriority;
  /** Used only by cancellable best-effort work such as hover warmups and previews. */
  signal?: AbortSignal;
  /**
   * Set only after the HTTP boundary has verified a short-lived, signed,
   * viewer-and-stream-bound shared authorization receipt. It lets a player
   * routed to another application replica reuse the completed warmup for its
   * short lifetime; the signed stream grant and File dereference still run.
   * Never accept this from browser input directly.
   */
  hasRecentSharedAuthorizationReceipt?: boolean;
  /** Server-only, fixed-schema latency observation for the initial player open. */
  onTiming?: (timing: MediaResolutionTiming) => void;
  /** Server-only, fixed source-proof context with no identifying values. */
  onAuthorizationContext?: (context: MediaAuthorizationTimingContext) => void;
}
export type SharedSpaceProbe =
  | { eName: string; kind: 'group' }
  | { eName: string; kind: 'direct'; chatId: string; viewerChatGrantId?: string }
  | { eName: string; kind: 'reference'; referenceId: string; fileId: string };
export type SharedSpaceAccess = {
  access: 'ok' | 'denied' | 'missing' | 'retry';
  member: boolean;
};
type ExactSharedCallProofOutcome = 'not_eligible' | 'verified' | 'denied' | 'retry';
/**
 * A completed exact-record check can either prove the current share, identify
 * a contradiction in its current records, or be inconclusive for a legacy
 * record shape. The latter must retain the established verifier: historical
 * Chats legitimately store User metaIds instead of eNames, so treating an
 * unknown identifier as a negative entitlement would make valid videos look
 * unavailable.
 */
type ExactSharedCallProofValidation = Exclude<ExactSharedCallProofOutcome, 'retry'>;
type ExactParticipantIdentityResolver = (
  participantId: string,
  expectedEName: string,
  expectedVault: ResolvedVault,
) => Promise<boolean>;
interface ExactSharedCallProofContext {
  source: Extract<SharedSpaceProbe, { kind: 'direct' }>;
  callSessionId: string;
  callSessionVault: string;
  chatId: string;
  viewerChatGrantId: string;
  fileUri: string;
  recordingVault?: string;
}
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
interface CachedEVaultResolution {
  vault: ResolvedVault;
  expiresAt: number;
}

interface ResolvedEVaultLookup {
  vault: ResolvedVault;
  /** True only when this request used an already-completed directory cache entry. */
  cacheHit: boolean;
}

interface PendingMediaUrlResolution {
  promise: Promise<string>;
  timing: MediaResolutionTiming;
}

/** Pending background work must never become the clock that a Watch click uses. */
function sourceReadPolicyPendingKey(policy: SourceReadPolicy): string {
  return policy;
}

function reserveInteractiveVaultGate(vaultKey: string, notBefore: number, now: number): void {
  for (const [existingKey, existingNotBefore] of interactiveVaultGates) {
    if (existingNotBefore <= now) interactiveVaultGates.delete(existingKey);
  }
  const key = normalizeEName(vaultKey);
  if (!key) return;
  if (!interactiveVaultGates.has(key) && interactiveVaultGates.size >= maxInteractiveVaultGates) {
    const oldestKey = interactiveVaultGates.keys().next().value;
    if (oldestKey) interactiveVaultGates.delete(oldestKey);
  }
  interactiveVaultGates.set(key, Math.max(interactiveVaultGates.get(key) ?? 0, notBefore));
}

function interactiveVaultNotBefore(vaultKey: string, now: number): number {
  const key = normalizeEName(vaultKey);
  const notBefore = interactiveVaultGates.get(key) ?? 0;
  if (notBefore <= now) {
    if (notBefore) interactiveVaultGates.delete(key);
    return 0;
  }
  return notBefore;
}

function isStaleGenericFileRecord(value: unknown): boolean {
  const item = record(value);
  return item?.sourceId === 'file-record' && isGenericVideoSpaceTitle(optionalString(item.title));
}

/**
 * The deferred resolver only needs display and media-classification hints. A
 * full Message payload can contain arbitrary message bodies and nested data;
 * storing it in every pending task caused production inventory checkpoints to
 * grow with the complete chat history. Keep a deliberately small, shallow
 * allowlist so resolution can enrich a video card without retaining that data.
 */
export function compactMediaSourceMetadata(payload: RecordValue): RecordValue {
  const result: RecordValue = {};
  for (const key of [
    'type',
    'title',
    'caption',
    'content',
    'chatId',
    'chatTitle',
    'createdAt',
    'durationSec',
    'shape',
    'contentType',
    'mimeType',
    'filename',
    'name',
  ]) {
    const value = payload[key];
    if (typeof value === 'string') result[key] = value.slice(0, maxDeferredMetadataStringLength);
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  for (const key of ['file', 'attachment', 'media']) {
    const nested = record(payload[key]);
    if (!nested) continue;
    const compact: RecordValue = {};
    for (const nestedKey of [
      'filename',
      'name',
      'displayName',
      'contentType',
      'mimeType',
      'fileUri',
      'mediaUri',
      'uri',
      'url',
      'id',
    ]) {
      const value = nested[nestedKey];
      if (typeof value === 'string')
        compact[nestedKey] = value.slice(0, maxDeferredMetadataStringLength);
      else if (typeof value === 'number' || typeof value === 'boolean') compact[nestedKey] = value;
    }
    if (Object.keys(compact).length) result[key] = compact;
  }
  return result;
}

function appendRetained<T>(target: T[], records: readonly T[], limit: number): void {
  const available = limit - target.length;
  if (available <= 0 || records.length === 0) return;
  target.push(...records.slice(0, available));
}

/** A canonical record that is explicitly non-video must remove its temporary File-reference card. */
function discardFileReferencePlaceholder(found: DiscoveredVideo[], fileUri: string): void {
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const item = found[index];
    if (!item) continue;
    if (
      item.sourceId === 'file-record' &&
      item.title === 'Shared video' &&
      item.fileUris.includes(fileUri)
    ) {
      found.splice(index, 1);
    }
  }
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
// Shared playback needs one named Chat/Chat-reference, never an arbitrary
// slice of the owner's chat history. The documented eVault search supports
// exact structured-field matching; include both canonical and legacy field
// names because historical Chat references use either shape.
const exactChatAuthorizationQuery = `query ExactChatAuthorization($ontologyId: ID!, $chatId: String!, $first: Int!) {
  metaEnvelopes(filter: { ontologyId: $ontologyId, search: { term: $chatId, fields: ["id", "chatId", "canonicalChatId"], mode: EXACT } }, first: $first) {
    edges { node { ${envelopeNode} } }
    pageInfo { hasNextPage endCursor }
  }
}`;
// A User participant can be stored as either the envelope id (handled by the
// direct `metaEnvelope(id)` read) or the User body's documented `id`. This
// query is the bounded exact fallback for the latter, not a history scan.
const exactUserIdentityQuery = `query ExactUserParticipantIdentity($ontologyId: ID!, $participantId: String!, $first: Int!) {
  metaEnvelopes(filter: { ontologyId: $ontologyId, search: { term: $participantId, fields: ["id"], mode: EXACT } }, first: $first) {
    edges { node { ${envelopeNode} } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const readQuery = `query MeshengerVideoEnvelope($id: ID!) { metaEnvelope(id: $id) { ${envelopeNode} } }`;
const cachedMediaUrls = new Map<string, CachedMediaUrl>();
/** Source-issued grants are already exact, short-lived shared-access proofs. */
const cachedMeshengerPlaybackGrantUrls = new Map<string, CachedMediaUrl>();
const pendingMeshengerPlaybackGrantResolutions = new Map<
  string,
  Promise<MeshengerPlaybackGrantResult>
>();
// Durable vault gates coordinate separate workers, but writing one to
// Postgres is asynchronous. Keep the same short-lived gate in-process so an
// inventory drain cannot start its next eVault page in the gap between a
// Watch click and that durable write completing.
const interactiveVaultGates = new Map<string, number>();
const maxInteractiveVaultGates = 256;
// A native video element can issue several initial Range and metadata requests
// before its first response is ready. Keep one source resolution per
// viewer/file and priority until it settles: an interactive request must never
// wait behind a background retry budget.
const pendingMediaUrlResolutions = new Map<string, PendingMediaUrlResolution>();
const directFileFallbackPreferred = new Map<string, number>();
const cachedEVaultResolutions = new Map<string, CachedEVaultResolution>();
const pendingEVaultResolutions = new Map<string, Promise<ResolvedVault>>();
const cachedPlatformTokens = new Map<string, { token: string; expiresAt: number }>();
const pendingPlatformTokens = new Map<string, Promise<string>>();
// Production callers never reset this map. The companion controllers let the
// test cache reset stop an in-flight retry rather than letting it escape into
// the next isolated request fixture.
const pendingPlatformTokenControllers = new Map<string, AbortController>();
const platformTokenCacheTtlMs = 5 * 60_000;
const maxCachedPlatformTokens = 16;
// Native media elements retain their original `src` while issuing subsequent
// Range requests. Retain the renewed opaque grant server-side so one expired
// URL does not mint a fresh grant per range. Every request still calls
// resolveMediaUrl and rechecks current source authorization.
const renewedStreams = new Map<string, RenewedStream>();

class MediaResolutionAbortedError extends Error {
  constructor() {
    super('Background media resolution was cancelled.');
    this.name = 'MediaResolutionAbortedError';
  }
}

/**
 * Durable inventory uses a separately keyed cancellable source policy. It is
 * deliberately selected only when the pump supplied a lease signal, so normal
 * HTTP catalogue hydration keeps its existing fail-fast behavior.
 */
function inventorySourceReadPolicy(signal: AbortSignal | undefined): SourceReadPolicy {
  return signal ? 'inventory-cancellable' : 'fail-fast';
}

function isInventoryScanCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && error instanceof MediaResolutionAbortedError;
}

type MediaResolutionTimedPhase = Exclude<keyof MediaResolutionTiming, 'mediaUrlCacheHit'>;

function createMediaResolutionTiming(): MediaResolutionTiming {
  return {
    mediaUrlCacheHit: false,
    sharedAccessVerificationMs: 0,
    eVaultResolutionMs: 0,
    directFileDereferenceMs: 0,
    platformTokenMs: 0,
    metadataReadMs: 0,
  };
}

async function measureMediaResolutionPhase<T>(
  timing: MediaResolutionTiming | undefined,
  phase: MediaResolutionTimedPhase,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    if (timing) timing[phase] += Math.max(0, performance.now() - startedAt);
  }
}

function reportMediaResolutionTiming(
  options: MediaResolutionOptions | undefined,
  timing: MediaResolutionTiming,
): void {
  if (!options?.onTiming) return;
  // The observer is diagnostic-only. A logging failure must never affect a
  // private media response.
  try {
    options.onTiming({ ...timing });
  } catch {
    // Intentionally ignored.
  }
}

function reportMediaAuthorizationContext(
  options: MediaResolutionOptions | undefined,
  context: MediaAuthorizationTimingContext,
): void {
  if (!options?.onAuthorizationContext) return;
  // The observer is diagnostic-only. A logging failure must never affect a
  // private media response.
  try {
    options.onAuthorizationContext({ ...context });
  } catch {
    // Intentionally ignored.
  }
}

function throwIfMediaResolutionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MediaResolutionAbortedError();
}

function sourceRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** Combines a caller cancellation with a branch-local best-effort cancellation. */
function combineMediaResolutionSignals(
  parent: AbortSignal | undefined,
  child: AbortSignal,
): AbortSignal {
  return parent ? AbortSignal.any([parent, child]) : child;
}

/**
 * Stops a cancelled preview from waiting on a process-wide pending request
 * without cancelling a reusable interactive/token resolution that another
 * request may still need.
 */
function awaitMediaResolution<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(new MediaResolutionAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new MediaResolutionAbortedError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function sleepForMediaResolution(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new MediaResolutionAbortedError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new MediaResolutionAbortedError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Returns no value when a non-authoritative local optimization is slow. Its
 * rejection is deliberately swallowed by the caller: a pointer lookup must
 * never become an authorization failure or lengthen the legacy proof path.
 */
function awaitBoundedMediaOptimization<T>(
  pending: Promise<T>,
  maxWaitMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) return Promise.reject(new MediaResolutionAbortedError());
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new MediaResolutionAbortedError());
    };
    const timer = setTimeout(() => finish(undefined), maxWaitMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.then(finish, () => finish(undefined));
  });
}

function getInventoryJobStoreForLibrary(): InventoryJobStore {
  if (process.env.DATABASE_URL?.trim()) return getInventoryJobStore();
  return createMemoryInventoryJobStore();
}

/**
 * Read-only Meshenger source. It indexes envelope references and metadata only;
 * public CDN URLs are resolved only inside `resolveMediaUrl` for the stream route.
 */
export class MeshengerVideoLibrary {
  private readonly jobStore: InventoryJobStore;
  private readonly viewerChatGrantPointerStore: ViewerChatGrantPointerStore;
  private readonly now: () => number;

  constructor(
    private readonly config: Config,
    options?: {
      jobStore?: InventoryJobStore;
      viewerChatGrantPointerStore?: ViewerChatGrantPointerStore;
      now?: () => number;
    },
  ) {
    this.jobStore = options?.jobStore ?? getInventoryJobStoreForLibrary();
    this.viewerChatGrantPointerStore =
      options?.viewerChatGrantPointerStore ?? getViewerChatGrantPointerStore();
    this.now = options?.now ?? (() => Date.now());
  }

  /**
   * Check the synchronous local gate first. The durable gate still protects
   * other workers, but waiting for its write/read is unnecessary when this
   * process has just received an explicit Watch intent for the same vault.
   */
  private async inventoryVaultNotBefore(vaultKey: string, timestamp: number): Promise<number> {
    const localGate = interactiveVaultNotBefore(vaultKey, timestamp);
    if (localGate > timestamp) return localGate;
    const durableGate = await this.jobStore.vaultNotBefore(vaultKey, timestamp);
    // A Watch action may arrive while the durable lookup is in flight. Check
    // the in-process gate again before handing this value back to a queue
    // dispatcher, otherwise one just-selected background request can slip
    // through that small async gap.
    const afterLookup = this.now();
    return Math.max(durableGate, interactiveVaultNotBefore(vaultKey, afterLookup));
  }

  /**
   * A just-read Chat envelope in the viewer's own vault is the same durable
   * direct-share proof that `probeViewerChatGrantAccess` later checks before
   * playback. Reuse that positive result only through the existing short
   * in-memory proof cache: no source URL, persisted authorization state, or
   * GroupManifest membership is inferred here.
   */
  private rememberCurrentViewerDirectChatGrantProofs(
    viewerEName: string,
    references: readonly ChatReference[],
  ): void {
    for (const reference of references) {
      // A group Chat is authorized by its current GroupManifest, not a direct
      // Chat grant. An omitted legacy type remains eligible because the
      // playback verifier accepts the same viewer-side Chat evidence.
      if (reference.type === 'group') continue;
      rememberVerifiedSharedAccess(viewerEName, {
        eName: reference.groupEName,
        kind: 'direct',
        chatId: reference.chatId,
      });
      this.rememberViewerChatGrantPointer(
        viewerEName,
        reference.groupEName,
        reference.chatId,
        reference.viewerChatGrantId,
      );
    }
  }

  /**
   * Persist only a locator into a viewer's own Chat history. This deliberately
   * runs best-effort: database health must never decide authorization or add
   * latency to catalogue rendering. Playback still re-reads and validates the
   * exact envelope before it can use a pointer.
   */
  private rememberViewerChatGrantPointer(
    viewerEName: string,
    sourceEName: string,
    sourceChatId: string,
    viewerEnvelopeId: string | undefined,
  ): void {
    if (!viewerEnvelopeId || sameEName(viewerEName, sourceEName)) return;
    void this.viewerChatGrantPointerStore
      .upsert({
        viewerEName,
        sourceEName,
        sourceChatId,
        viewerEnvelopeId,
      })
      .catch(() => undefined);
  }

  /**
   * A pointer read is local and bounded. It is not a permission check, so a
   * slow or unavailable database simply falls through to the authoritative
   * existing Chat lookup without delaying the player.
   */
  private async viewerChatGrantPointerIds(
    viewerEName: string,
    sourceEName: string,
    sourceChatId: string,
  ): Promise<string[]> {
    const candidates = await this.viewerChatGrantPointerStore
      .listCandidates({ viewerEName, sourceEName, sourceChatId })
      .catch(() => []);
    return [...new Set(candidates.map((candidate) => candidate.viewerEnvelopeId))];
  }

  private invalidateViewerChatGrantPointer(
    viewerEName: string,
    sourceEName: string,
    sourceChatId: string,
    viewerEnvelopeId: string,
  ): void {
    // A mismatch only invalidates this opaque envelope ID. In particular it
    // cannot erase a newer pointer concurrently learned from the viewer vault.
    void this.viewerChatGrantPointerStore
      .markInvalid({ viewerEName, sourceEName, sourceChatId, viewerEnvelopeId })
      .catch(() => undefined);
  }

  /**
   * A GroupManifest just read from the group's current eVault is the same
   * durable membership proof that `probeSharedSpaceAccess` checks before
   * opening a membership-backed stream. Reuse only that completed positive
   * result through the existing short in-memory proof cache; no group data,
   * URL, or authorization decision is persisted.
   *
   * This is intentionally called only from the first-page open path, because
   * the playback verifier uses the same bounded GroupManifest read.
   */
  private rememberCurrentViewerGroupMembershipProof(viewerEName: string, groupEName: string): void {
    rememberVerifiedSharedAccess(viewerEName, { eName: groupEName, kind: 'group' });
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
    this.rememberCurrentViewerDirectChatGrantProofs(eName, chatReferences);
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
      /** Optional checkpoint budget for a resumable background drain. */
      maxWaves?: number;
      /** Bound background source fan-out without slowing an interactive listing. */
      maxVaultsPerWave?: number;
      /**
       * Process-local cancellation for resumable inventory work. Both the
       * durable pump and a cache-miss checkpoint may use it; neither reaches
       * shared platform-token work.
       */
      signal?: AbortSignal;
      onSnapshot: (
        library: MeshengerLibrary,
        phase: InventoryScanPhase,
        counts: InventorySourceCounts,
      ) => void;
    },
  ): Promise<MeshengerLibrary> {
    const eName = requireEName(user.eName);
    const counts = emptySourceCounts();
    // A cache-miss checkpoint is resumable background work too. Honour its
    // lease signal so an explicit Watch request can preempt the tiny setup
    // read instead of sharing the constrained worker with it. `drain: false`
    // still prevents the checkpoint from performing the durable page drain.
    const inventorySignal = options.signal;
    const cancelledBatch = (): MeshengerLibrary => {
      const library: MeshengerLibrary = {
        items: [],
        conversations: [],
        messages: [],
        completeness: { ...completeInventory, complete: false },
      };
      options.onSnapshot(library, 'batch', counts);
      return library;
    };
    // The lease may be preempted while the pump is between its durable-job
    // lookup and the first source call. Do not begin a directory read in that
    // gap; the next tick resumes the same persisted job.
    if (inventorySignal?.aborted) return cancelledBatch();
    if (options.refresh) {
      const current = await this.jobStore.getByOwner(eName);
      if (current?.status === 'complete') {
        await this.restartCatalogueJob(
          current,
          user.eVaultUri ? httpUrl(user.eVaultUri) : current.ownerEVaultUri,
        );
      }
    }
    let ownVault: ResolvedVault;
    try {
      ownVault = user.eVaultUri
        ? { ownerEName: eName, eVaultUri: httpUrl(user.eVaultUri) }
        : await this.resolveEVault(
            eName,
            inventorySourceReadPolicy(inventorySignal),
            inventorySignal,
          );
    } catch (error) {
      if (isInventoryScanCancellation(error, inventorySignal)) return cancelledBatch();
      throw error;
    }
    const drain = options.drain !== false;
    if (options.scope === 'owned') {
      return this.scanOwnedProgressive(eName, ownVault, counts, options.onSnapshot, { drain });
    }
    const resumableDrain = {
      drain,
      ...(options.maxWaves !== undefined ? { maxWaves: options.maxWaves } : {}),
      ...(options.maxVaultsPerWave !== undefined
        ? { maxVaultsPerWave: options.maxVaultsPerWave }
        : {}),
      ...(inventorySignal ? { signal: inventorySignal } : {}),
    };
    if (options.scope === 'shared') {
      return this.scanSharedProgressive(
        eName,
        ownVault,
        counts,
        options.onSnapshot,
        resumableDrain,
      );
    }
    return this.scanCompleteProgressive(
      eName,
      ownVault,
      counts,
      options.onSnapshot,
      resumableDrain,
    );
  }

  /**
   * Start a fresh catalogue pass without deleting the cards already discovered.
   * Replacing a completed job cascades through inventory items in Postgres, which
   * makes a refresh look like a smaller library until every source is scanned
   * again. Keep the job ID and its last known catalogue while clearing only
   * resumable work and completeness counters.
   */
  private async restartCatalogueJob(
    job: InventoryJobRecord,
    ownerEVaultUri: string,
  ): Promise<InventoryJobRecord> {
    const completeness = createInventoryCompletenessTracker();
    completeness.markRetry();
    const { completedAt: _completedAt, ...activeJob } = job;
    const found = Array.isArray(job.ledger.found)
      ? job.ledger.found.filter(
          (item) =>
            !isStaleGenericFileRecord(item) &&
            // Retain only cards that already carry a durable authorization
            // path. They stay safe because every media request verifies that
            // proof again, while preserving them avoids an empty Shared tab
            // during a catalogue-version reindex. Legacy cards without such
            // proof are rebuilt before they become playable.
            (record(item)?.accessScope !== 'shared' || hasReusableSharedProof(item)),
        )
      : [];
    const restarted: InventoryJobRecord = {
      ...activeJob,
      ownerEVaultUri,
      status: 'running',
      completeness: completeness.snapshot(),
      ledger: {
        found,
        queue: [],
        drainFinished: false,
        catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
      },
      sourceCounts: emptySourceCounts(),
      updatedAt: this.now(),
    };
    await this.jobStore.replaceOpenTasks(job.id, []);
    await this.jobStore.saveJob(restarted);
    return restarted;
  }

  /** Lightweight shared-space probe for cached metadata. Does not list videos. */
  async probeSharedSpaceAccess(
    user: ViewerIdentity,
    space: SharedSpaceProbe,
    rateLimit: SourceReadPolicy = 'fail-fast',
    options?: { signal?: AbortSignal },
  ): Promise<SharedSpaceAccess> {
    const signal = options?.signal;
    throwIfMediaResolutionAborted(signal);
    requireEName(user.eName);
    if (space.kind === 'reference') {
      // A direct File share is represented by a reference stored in the
      // viewer's own eVault. Re-read that specific envelope and bind it to the
      // canonical file before returning the card or opening its media. This is
      // the actual authorization evidence; a canonical owner's vault need not
      // have a GroupManifest, so probing one here made legitimate shares vanish.
      const viewerVaultRead = await this.readSource(
        () => this.resolveViewerEVault(user, rateLimit, signal),
        undefined,
      );
      if (viewerVaultRead.failure === 'denied') return { access: 'denied', member: false };
      if (viewerVaultRead.failure === 'missing') return { access: 'missing', member: false };
      if (isRetryFailure(viewerVaultRead.failure) || !viewerVaultRead.value) {
        return { access: 'retry', member: false };
      }
      const viewerVault = viewerVaultRead.value;
      const referenceRead = await this.readSource(
        () =>
          this.readEnvelope(
            viewerVault.ownerEName,
            viewerVault.eVaultUri,
            space.referenceId,
            rateLimit,
            undefined,
            signal,
          ),
        undefined,
      );
      if (referenceRead.failure === 'denied') return { access: 'denied', member: false };
      if (referenceRead.failure === 'missing') return { access: 'missing', member: false };
      if (isRetryFailure(referenceRead.failure) || !referenceRead.value) {
        return { access: 'retry', member: false };
      }
      const target = fileRecordReferenceTarget(referenceRead.value);
      if (!target) return { access: 'missing', member: false };
      return {
        access:
          sameEName(target.ownerEName, space.eName) && target.metaEnvelopeId === space.fileId
            ? 'ok'
            : 'denied',
        member: sameEName(target.ownerEName, space.eName) && target.metaEnvelopeId === space.fileId,
      };
    }
    if (space.kind === 'direct') {
      if (!space.chatId) return { access: 'missing', member: false };

      // Interactive playback can use either the source's current Chat mirror
      // or the viewer's durable Chat grant. Probe both exact records in
      // parallel so historical shares do not wait for a negative remote check
      // before proving the viewer's authorization. Background inventory keeps
      // the lighter single-source probe to avoid needless remote load.
      if (
        rateLimit === 'backoff' ||
        rateLimit === 'interactive' ||
        rateLimit === 'warmup-cancellable'
      ) {
        const sourceChatController = new AbortController();
        const viewerChatController = new AbortController();
        // The registry lookup is process-wide cacheable directory metadata.
        // Do not attach a branch-loser controller to it: aborting an in-flight
        // /resolve could otherwise cancel another Watch request for the same
        // vault. Apply the child signal only to the branch-specific Chat read.
        const sourceAccessPromise = this.probeDirectSourceChatAccess(
          user,
          space,
          rateLimit,
          signal,
          combineMediaResolutionSignals(signal, sourceChatController.signal),
        );
        const safeSourceAccessPromise = sourceAccessPromise.catch(
          () => ({ access: 'retry', member: false }) as const,
        );
        const viewerAccessPromise = this.probeViewerChatGrantAccess(
          user,
          {
            eName: space.eName,
            chatId: space.chatId,
            ...(space.viewerChatGrantId ? { viewerChatGrantId: space.viewerChatGrantId } : {}),
          },
          rateLimit,
          signal,
          combineMediaResolutionSignals(signal, viewerChatController.signal),
        ).catch(() => ({ access: 'retry', member: false }) as const);
        const first = await Promise.race([
          safeSourceAccessPromise.then((access) => ({ source: true as const, access })),
          viewerAccessPromise.then((access) => ({ source: false as const, access })),
        ]);
        if (first.access.access === 'ok' && first.access.member) {
          if (first.source) viewerChatController.abort();
          else sourceChatController.abort();
          return first.access;
        }
        const second = first.source ? await viewerAccessPromise : await safeSourceAccessPromise;
        if (second.access === 'ok' && second.member) return second;
        return combineSharedAccess(first.access, second);
      }

      const sourceAccessPromise = this.probeDirectSourceChatAccess(user, space, rateLimit, signal);
      const sourceAccess = await sourceAccessPromise;
      if (sourceAccess.access === 'ok' && sourceAccess.member) return sourceAccess;

      // The viewer's Chat grant is the durable authority for historical direct
      // shares. A source-side mirror can legitimately omit the viewer, so it
      // must never by itself remove an otherwise authorized card or block its
      // player.
      const viewerAccess = await this.probeViewerChatGrantAccess(
        user,
        {
          eName: space.eName,
          chatId: space.chatId,
          ...(space.viewerChatGrantId ? { viewerChatGrantId: space.viewerChatGrantId } : {}),
        },
        rateLimit,
        signal,
      );
      if (viewerAccess.access === 'ok' && viewerAccess.member) return viewerAccess;
      if (sourceAccess.access === 'retry' || viewerAccess.access === 'retry') {
        return { access: 'retry', member: false };
      }
      if (sourceAccess.access === 'denied' || viewerAccess.access === 'denied') {
        return { access: 'denied', member: false };
      }
      return { access: 'missing', member: false };
    }
    const vaultRead = await this.readSource(
      () => this.resolveEVault(space.eName, rateLimit, signal),
      undefined,
    );
    if (vaultRead.failure === 'denied') return { access: 'denied', member: false };
    if (vaultRead.failure === 'missing') return { access: 'missing', member: false };
    if (isRetryFailure(vaultRead.failure) || !vaultRead.value) {
      return { access: 'retry', member: false };
    }
    const vault = vaultRead.value;
    const manifests = await this.readSource(
      () =>
        this.listEnvelopes(vault.ownerEName, vault.eVaultUri, groupManifestOntology, undefined, {
          maxPages: 1,
          rateLimit,
          ...(signal ? { signal } : {}),
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

  /**
   * Direct/shared history is first discovered from a Chat record in the
   * viewer's own vault. Some older source vaults retain a call but no longer
   * expose the viewer in their mirrored participant list, so that mirror is
   * not a reliable negative authorization signal. Recheck the viewer's
   * current Chat grant as the durable fallback before denying playback.
   */
  private async probeViewerChatGrantAccess(
    user: ViewerIdentity,
    source: { eName: string; chatId: string; viewerChatGrantId?: string },
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
    chatSignal: AbortSignal | undefined = signal,
  ): Promise<SharedSpaceAccess> {
    // Start the local lookup while the ordinary viewer-vault resolution is
    // already in flight. A durable pointer can avoid an indexed-plus-history
    // query for legacy streams and can recover promptly when a sealed stream
    // hint refers to an older, replaced viewer Chat envelope.
    const pointerIds = usesDirectChatEnvelopeFastPath(rateLimit)
      ? this.viewerChatGrantPointerIds(user.eName, source.eName, source.chatId)
      : undefined;
    const viewerVaultRead = await this.readSource(
      () => this.resolveViewerEVault(user, rateLimit, signal),
      undefined,
    );
    if (viewerVaultRead.failure === 'denied') return { access: 'denied', member: false };
    if (viewerVaultRead.failure === 'missing') return { access: 'missing', member: false };
    if (isRetryFailure(viewerVaultRead.failure) || !viewerVaultRead.value) {
      return { access: 'retry', member: false };
    }
    const viewerVault = viewerVaultRead.value;
    const durablePointerIds = pointerIds
      ? await awaitBoundedMediaOptimization(
          pointerIds,
          viewerChatGrantPointerLookupBudgetMs,
          signal,
        )
      : [];
    const viewerChatGrantIds = [
      ...(source.viewerChatGrantId ? [source.viewerChatGrantId] : []),
      ...(durablePointerIds ?? []),
    ].filter((id, index, all) => all.indexOf(id) === index);
    const viewerChatGrantId = viewerChatGrantIds[0];
    const chatsRead = await this.readSource(
      () =>
        usesDirectChatEnvelopeFastPath(rateLimit) && viewerChatGrantId
          ? this.findInteractiveViewerChatGrantAuthorizationEnvelopes(
              viewerVault.ownerEName,
              viewerVault.eVaultUri,
              {
                ...source,
                viewerChatGrantId,
                ...(viewerChatGrantIds.length > 1 ? { viewerChatGrantIds } : {}),
              },
              user.eName,
              rateLimit,
              chatSignal,
            )
          : this.findChatAuthorizationEnvelopes(
              viewerVault.ownerEName,
              viewerVault.eVaultUri,
              source.chatId,
              rateLimit,
              chatSignal,
            ),
      [] as Envelope[],
    );
    if (chatsRead.failure === 'denied') return { access: 'denied', member: false };
    if (chatsRead.failure === 'missing') return { access: 'missing', member: false };
    if (isRetryFailure(chatsRead.failure)) return { access: 'retry', member: false };
    const matchingGrant = chatGrantsFromEnvelopes(chatsRead.value, user.eName).find(
      (grant) => sameEName(grant.groupEName, source.eName) && grant.chatId === source.chatId,
    );
    this.rememberViewerChatGrantPointer(
      user.eName,
      source.eName,
      source.chatId,
      matchingGrant?.viewerChatGrantId,
    );
    const authorized = Boolean(matchingGrant);
    return { access: authorized ? 'ok' : 'missing', member: authorized };
  }

  /**
   * The viewer's own Chat envelope is a durable, revocable direct-share
   * grant. A newly issued stream can carry its opaque ID, allowing the player
   * to re-read one exact current envelope instead of first searching legacy
   * chat history. The hint is positive-only: missing, malformed, changed, or
   * delayed hints immediately retain the existing indexed-plus-legacy lookup.
   */
  private async findInteractiveViewerChatGrantAuthorizationEnvelopes(
    owner: string,
    eVaultUri: string,
    source: {
      eName: string;
      chatId: string;
      viewerChatGrantId: string;
      viewerChatGrantIds?: readonly string[];
    },
    viewerEName: string,
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
  ): Promise<Envelope[]> {
    const fallbackController = new AbortController();
    const exactController = new AbortController();
    const fallbackSignal = combineMediaResolutionSignals(signal, fallbackController.signal);
    const exactSignal = combineMediaResolutionSignals(signal, exactController.signal);
    let startFallbackNow: () => void = () => undefined;
    const fallbackStart = new Promise<void>((resolve) => {
      startFallbackNow = resolve;
    });

    const fallbackLookup = (async () => {
      try {
        // Give the O(1) current viewer-grant read a short head start. A fast
        // negative result resolves `fallbackStart` below, so it never turns a
        // stale hint into an added 250 ms penalty.
        await Promise.race([
          sleepForMediaResolution(interactiveDirectChatEnvelopeHedgeDelayMs, fallbackSignal),
          fallbackStart,
        ]);
        throwIfMediaResolutionAborted(fallbackSignal);
        const items = await this.findChatAuthorizationEnvelopes(
          owner,
          eVaultUri,
          source.chatId,
          rateLimit,
          fallbackSignal,
        );
        return { kind: 'lookup' as const, items };
      } catch (error) {
        return { kind: 'lookup-error' as const, error };
      }
    })();
    const viewerChatGrantIds = [
      source.viewerChatGrantId,
      ...(source.viewerChatGrantIds ?? []),
    ].filter((id, index, all) => all.indexOf(id) === index);
    const exactGrant = new Promise<
      { kind: 'positive-hint'; envelope: Envelope } | { kind: 'no-hint-proof' }
    >((resolve) => {
      let remaining = viewerChatGrantIds.length;
      const noHintProof = () => {
        remaining -= 1;
        if (remaining === 0) resolve({ kind: 'no-hint-proof' });
      };
      for (const viewerChatGrantId of viewerChatGrantIds) {
        void this.readEnvelope(
          owner,
          eVaultUri,
          viewerChatGrantId,
          rateLimit,
          undefined,
          exactSignal,
        ).then(
          (envelope) => {
            if (viewerChatGrantEnvelopeMatchesSource(envelope, source, viewerEName)) {
              resolve({ kind: 'positive-hint', envelope });
              return;
            }
            // A successfully read envelope that no longer binds this exact
            // direct source is stale. Mark only this pointer unusable; network
            // failures retain no negative authority and do not change storage.
            this.invalidateViewerChatGrantPointer(
              viewerEName,
              source.eName,
              source.chatId,
              viewerChatGrantId,
            );
            noHintProof();
          },
          () => noHintProof(),
        );
      }
    });

    const first = await Promise.race([fallbackLookup, exactGrant]);
    if (first.kind === 'positive-hint') {
      // A positive current viewer-side grant is sufficient evidence. Stop
      // only this request's fallback lookup; it cannot cancel a shared source
      // proof or another viewer's authorization request.
      fallbackController.abort();
      exactController.abort();
      return [first.envelope];
    }
    if (first.kind === 'no-hint-proof') {
      // A quick miss has no negative authority. Release the existing lookup
      // immediately rather than waiting for the hedge delay.
      startFallbackNow();
      const settledLookup = await fallbackLookup;
      exactController.abort();
      if (settledLookup.kind === 'lookup') return settledLookup.items;
      throw settledLookup.error;
    }
    if (first.kind === 'lookup') {
      // The legacy search can only finish this race when it is itself a
      // positive current direct-share proof. An empty or unrelated result is
      // not authority to cancel the exact viewer-vault envelope that may
      // still arrive a moment later; doing so recreated the slow source-side
      // fallback for otherwise valid shared cards.
      if (
        first.items.some((envelope) =>
          viewerChatGrantEnvelopeMatchesSource(envelope, source, viewerEName),
        )
      ) {
        exactController.abort();
        return first.items;
      }
      const settledHint = await exactGrant;
      if (settledHint.kind === 'positive-hint') return [settledHint.envelope];
      return first.items;
    }
    // A legacy query failure is similarly not a negative result. Let the
    // exact viewer-vault proof finish before exposing the existing fallback
    // error; a positive current grant still authorizes playback safely.
    const settledHint = await exactGrant;
    if (settledHint.kind === 'positive-hint') return [settledHint.envelope];
    throw first.error;
  }

  /** Reads one exact source Chat record instead of paging unrelated history. */
  private async probeDirectSourceChatAccess(
    user: ViewerIdentity,
    space: Extract<SharedSpaceProbe, { kind: 'direct' }>,
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
    chatSignal: AbortSignal | undefined = signal,
  ): Promise<SharedSpaceAccess> {
    const vaultRead = await this.readSource(
      () => this.resolveEVault(space.eName, rateLimit, signal),
      undefined,
    );
    if (vaultRead.failure === 'denied') return { access: 'denied', member: false };
    if (vaultRead.failure === 'missing') return { access: 'missing', member: false };
    if (isRetryFailure(vaultRead.failure) || !vaultRead.value) {
      return { access: 'retry', member: false };
    }
    const sourceVault = vaultRead.value;
    const chats = await this.readSource(
      () =>
        usesDirectChatEnvelopeFastPath(rateLimit)
          ? this.findInteractiveSourceChatAuthorizationEnvelopes(
              sourceVault.ownerEName,
              sourceVault.eVaultUri,
              space.chatId,
              user.eName,
              rateLimit,
              chatSignal,
            )
          : this.findChatAuthorizationEnvelopes(
              sourceVault.ownerEName,
              sourceVault.eVaultUri,
              space.chatId,
              rateLimit,
              chatSignal,
            ),
      [] as Envelope[],
    );
    if (chats.failure === 'denied') return { access: 'denied', member: false };
    if (chats.failure === 'missing') return { access: 'missing', member: false };
    if (isRetryFailure(chats.failure)) return { access: 'retry', member: false };
    const chat = chats.value.find((item) => {
      const chatId = optionalString(item.parsed.id) ?? item.id;
      return chatId === space.chatId && item.parsed.isReference !== true;
    });
    if (!chat) return { access: 'missing', member: false };
    const member = asArray(chat.parsed.participantIds).some(
      (participant) => typeof participant === 'string' && sameEName(participant, user.eName),
    );
    return { access: 'ok', member };
  }

  /**
   * Keeps legacy source Chat compatibility without making every interactive
   * playback wait for it. The envelope-id read is deliberately incapable of
   * proving a negative: it can only short-circuit when it returns the current
   * source Chat, is not a reference, and includes this viewer. Every other
   * outcome waits for the normal indexed-plus-legacy lookup unchanged.
   */
  private async findInteractiveSourceChatAuthorizationEnvelopes(
    owner: string,
    eVaultUri: string,
    chatId: string,
    viewerEName: string,
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
  ): Promise<Envelope[]> {
    const indexedLookupController = new AbortController();
    const hedgeController = new AbortController();
    const indexedLookupSignal = combineMediaResolutionSignals(
      signal,
      indexedLookupController.signal,
    );
    const hedgeSignal = combineMediaResolutionSignals(signal, hedgeController.signal);

    // Convert each branch to a settled value before racing so cancelling the
    // loser cannot become an unhandled rejection after a valid positive proof
    // has already opened playback.
    const indexedLookup = this.findChatAuthorizationEnvelopes(
      owner,
      eVaultUri,
      chatId,
      rateLimit,
      indexedLookupSignal,
    ).then(
      (items) => ({ kind: 'lookup' as const, items }),
      (error: unknown) => ({ kind: 'lookup-error' as const, error }),
    );
    const sourceEnvelopeHedge = (async () => {
      try {
        await sleepForMediaResolution(interactiveDirectChatEnvelopeHedgeDelayMs, hedgeSignal);
        const envelope = await this.readEnvelope(
          owner,
          eVaultUri,
          chatId,
          rateLimit,
          undefined,
          hedgeSignal,
        );
        if (sourceChatEnvelopeIncludesViewer(envelope, chatId, viewerEName)) {
          return { kind: 'positive-hedge' as const, envelope };
        }
      } catch {
        // The hedge has no negative authority. This also intentionally ignores
        // a branch-local abort when the regular lookup wins first.
      }
      return { kind: 'no-hedge-proof' as const };
    })();

    const first = await Promise.race([indexedLookup, sourceEnvelopeHedge]);
    if (first.kind === 'positive-hedge') {
      // A completed positive source Chat is sufficient evidence. Stop only
      // this request's legacy lookup; its child signal never cancels a shared
      // registry lookup or another viewer's source proof.
      indexedLookupController.abort();
      return [first.envelope];
    }
    if (first.kind === 'lookup') {
      hedgeController.abort();
      return first.items;
    }
    if (first.kind === 'lookup-error') {
      hedgeController.abort();
      throw first.error;
    }

    // A missing, errored, referenced, malformed, or non-member envelope is
    // intentionally invisible to the authorization decision. The preexisting
    // source lookup (and then the viewer's grant probe) remains authoritative.
    const settledLookup = await indexedLookup;
    hedgeController.abort();
    if (settledLookup.kind === 'lookup') return settledLookup.items;
    throw settledLookup.error;
  }

  /**
   * A current direct CallSession can be authorized entirely with three exact
   * records: the viewer's durable Chat grant, the canonical source Chat, and
   * the canonical CallSession. This is deliberately stricter than the older
   * history lookup: a self-owned reference cannot by itself authorize foreign
   * media, and an invalid current pointer never falls through to a scan that
   * could accidentally revive a revoked share.
   */
  private async resolveExactSharedCallAuthorization(
    user: ViewerIdentity,
    grant: StreamGrant,
    priority: MediaResolutionPriority,
    signal?: AbortSignal,
  ): Promise<ExactSharedCallProofOutcome> {
    const context = exactSharedCallProofContext(grant);
    if (!context || priority === 'background') return 'not_eligible';
    if (hasVerifiedSharedAccess(user.eName, context.source, this.now())) return 'verified';

    const rateLimit: SourceReadPolicy =
      priority === 'interactive' ? 'interactive' : 'warmup-cancellable';
    // A valid exact proof is normally a handful of low-latency GraphQL reads.
    // If it cannot complete promptly, do not add the old multi-page lookup on
    // top of that wait. A player retry gets a fresh bounded attempt instead.
    const proofSignal =
      priority === 'interactive'
        ? sourceRequestSignal(interactiveExactSharedCallProofTimeoutMs, signal)
        : signal;
    const access = await coalesceSharedAccessProbe(
      user.eName,
      context.source,
      async () => {
        try {
          const validation = await this.verifyExactSharedCallProof(
            user,
            context,
            rateLimit,
            proofSignal,
          );
          if (validation === 'verified') return { access: 'ok', member: true } as const;
          if (validation === 'denied') return { access: 'denied', member: false } as const;
          // Do not cache an inconclusive fast-path attempt. The caller will
          // use the existing bridge / historical proof, which understands
          // legacy participant identity forms.
          return { access: 'missing', member: false } as const;
        } catch (error) {
          if (error instanceof MediaResolutionAbortedError) {
            if (signal?.aborted) throw error;
            return { access: 'retry', member: false } as const;
          }
          // A missing exact record can be a short replication delay or an
          // older card that retained a stale pointer. It is not proof that a
          // viewer lost access, so retain the established verifier. An actual
          // source authorization rejection remains a fast denial.
          const failure = sourceFailureClass(error);
          if (failure === 'denied') {
            return { access: 'denied', member: false } as const;
          }
          if (failure === 'missing') return { access: 'missing', member: false } as const;
          return { access: 'retry', member: false } as const;
        }
      },
      this.now(),
      this.now,
      { priority },
    );
    if (access.access === 'ok' && access.member) return 'verified';
    if (access.access === 'retry') return 'retry';
    if (access.access === 'denied') return 'denied';
    return 'not_eligible';
  }

  private async verifyExactSharedCallProof(
    user: ViewerIdentity,
    context: ExactSharedCallProofContext,
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
  ): Promise<ExactSharedCallProofValidation> {
    const [viewerVault, callSessionVault] = await Promise.all([
      this.resolveViewerEVault(user, rateLimit, signal),
      this.resolveEVault(context.callSessionVault, rateLimit, signal),
    ]);
    const [viewerChat, sourceChat, callSession] = await Promise.all([
      this.readEnvelope(
        viewerVault.ownerEName,
        viewerVault.eVaultUri,
        context.viewerChatGrantId,
        rateLimit,
        undefined,
        signal,
      ),
      this.readEnvelope(
        callSessionVault.ownerEName,
        callSessionVault.eVaultUri,
        context.chatId,
        rateLimit,
        undefined,
        signal,
      ),
      this.readEnvelope(
        callSessionVault.ownerEName,
        callSessionVault.eVaultUri,
        context.callSessionId,
        rateLimit,
        undefined,
        signal,
      ),
    ]);
    const viewerValidation = viewerChatGrantExactDirectCallValidation(
      viewerChat,
      context,
      user.eName,
    );
    const sourceValidation = sourceChatExactDirectCallValidation(sourceChat, context, user.eName);
    const callSessionValidation = callSessionMatchesExactSharedFile(
      callSession,
      context,
      user.eName,
    )
      ? 'verified'
      : 'denied';
    const initialValidation = combineExactSharedCallProofValidations(
      viewerValidation,
      sourceValidation,
      callSessionValidation,
    );
    if (initialValidation !== 'not_eligible') return initialValidation;

    // `X-ENAME` selects the eVault tenant. Do not use an identity record as
    // evidence when the resolved vault does not remain bound to the known
    // viewer/source eName from the signed stream context.
    if (
      !sameEName(viewerVault.ownerEName, user.eName) ||
      !sameEName(callSessionVault.ownerEName, context.callSessionVault)
    ) {
      return 'not_eligible';
    }

    // The same opaque User id commonly appears in both the viewer copy and
    // the source Chat. Collapse those bounded exact reads within this one
    // proof, but deliberately do not persist identity data or turn it into a
    // general identity cache.
    const identityChecks = new Map<string, Promise<boolean>>();
    const resolveParticipant: ExactParticipantIdentityResolver = (
      participantId,
      expectedEName,
      expectedVault,
    ) => {
      const key = `${normalizeEName(expectedEName)}\u0000${participantId.trim()}`;
      const existing = identityChecks.get(key);
      if (existing) return existing;
      const pending = this.resolveExactUserParticipant(
        participantId,
        expectedEName,
        expectedVault,
        rateLimit,
        signal,
      );
      identityChecks.set(key, pending);
      return pending;
    };
    const [legacyViewerValidation, legacySourceValidation] = await Promise.all([
      viewerValidation === 'not_eligible'
        ? this.resolveLegacyExactDirectChatValidation(
            viewerChat,
            context,
            user.eName,
            viewerVault,
            callSessionVault,
            resolveParticipant,
          )
        : Promise.resolve(viewerValidation),
      sourceValidation === 'not_eligible'
        ? this.resolveLegacyExactDirectChatValidation(
            sourceChat,
            context,
            user.eName,
            viewerVault,
            callSessionVault,
            resolveParticipant,
          )
        : Promise.resolve(sourceValidation),
    ]);
    return combineExactSharedCallProofValidations(
      legacyViewerValidation,
      legacySourceValidation,
      callSessionValidation,
    );
  }

  /**
   * Resolve a legacy direct Chat pair only from the two identities already
   * fixed by the signed CallSession context. A User envelope is read from its
   * known owner's own vault by exact envelope id, with one exact documented
   * `User.id` lookup for installations that stored the body id instead. This
   * is bounded (four owner/id assignments per opaque direct Chat, deduplicated
   * across the proof), has no history scan, and a miss stays inconclusive so
   * the established verifier remains safe.
   */
  private async resolveLegacyExactDirectChatValidation(
    envelope: Envelope,
    context: ExactSharedCallProofContext,
    viewerEName: string,
    viewerVault: ResolvedVault,
    sourceVault: ResolvedVault,
    resolveParticipant: ExactParticipantIdentityResolver,
  ): Promise<ExactSharedCallProofValidation> {
    const participants = legacyExactDirectChatParticipantIds(envelope, context);
    if (!participants) return 'not_eligible';
    const [first, second] = participants;
    if (!first || !second) return 'not_eligible';

    // Participant order is not part of the Chat contract. Check both exact
    // assignments concurrently so a valid historical source copy does not
    // wait behind an arbitrary ordering guess.
    const [viewerFirst, sourceFirst] = await Promise.all([
      Promise.all([
        resolveParticipant(first, viewerEName, viewerVault),
        resolveParticipant(second, context.callSessionVault, sourceVault),
      ]),
      Promise.all([
        resolveParticipant(first, context.callSessionVault, sourceVault),
        resolveParticipant(second, viewerEName, viewerVault),
      ]),
    ]);
    return (viewerFirst[0] && viewerFirst[1]) || (sourceFirst[0] && sourceFirst[1])
      ? 'verified'
      : 'not_eligible';
  }

  /**
   * Match one opaque Chat participant to a known eName. A direct eName form
   * remains free; an opaque form can only succeed when a User record bearing
   * that exact envelope/body id is returned from that person's own eVault.
   */
  private async resolveExactUserParticipant(
    participantId: string,
    expectedEName: string,
    expectedVault: ResolvedVault,
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const id = participantId.trim();
    if (!id || !sameEName(expectedVault.ownerEName, expectedEName)) return false;
    if (isExplicitENameParticipant(id) || sameEName(id, expectedEName)) {
      return sameEName(id, expectedEName);
    }

    let direct: Envelope | undefined;
    try {
      direct = await this.readEnvelope(
        expectedVault.ownerEName,
        expectedVault.eVaultUri,
        id,
        rateLimit,
        undefined,
        signal,
      );
    } catch (error) {
      if (error instanceof MediaResolutionAbortedError) throw error;
      if (!isInconclusiveExactIdentityLookup(error)) throw error;
    }
    if (direct && isExactUserParticipantEnvelope(direct, id)) {
      return userEnvelopeBindsExpectedEName(direct, expectedEName);
    }

    let matches: Envelope[] = [];
    try {
      const data = await this.graphql(
        expectedVault.ownerEName,
        expectedVault.eVaultUri,
        exactUserIdentityQuery,
        { ontologyId: userOntology, participantId: id, first: 4 },
        rateLimit,
        undefined,
        signal,
      );
      matches = asArray(record(data.metaEnvelopes)?.edges)
        .map(envelopeFromEdge)
        .filter((item): item is Envelope => item !== undefined);
    } catch (error) {
      if (error instanceof MediaResolutionAbortedError) throw error;
      if (!isInconclusiveExactIdentityLookup(error)) throw error;
      return false;
    }
    return matches.some(
      (candidate) =>
        isExactUserParticipantEnvelope(candidate, id) &&
        userEnvelopeBindsExpectedEName(candidate, expectedEName),
    );
  }

  /**
   * The source-issued bridge is deliberately limited to canonical CallSession
   * recordings with an exact current viewer Chat grant. It replaces the slow
   * compatibility scan, but only after the source itself verifies all three
   * references and the requested File URI. A 409 means the source cannot prove
   * this legacy shape directly. A 404 can also be a short eVault replication
   * lag after a card was indexed. Both retain the established authenticated
   * verifier rather than turning a compatibility miss into a dead video.
   */
  private async resolveFastSharedCallPlayback(
    grant: StreamGrant,
    cacheKey: string,
    priority: MediaResolutionPriority,
    signal?: AbortSignal,
  ): Promise<FastSharedCallPlayback | undefined> {
    const callSessionVault =
      grant.sourceCallSessionVault ?? grant.sourceRecordingVault ?? grant.sourceSpaceKey;
    if (
      priority === 'background' ||
      grant.accessScope !== 'shared' ||
      grant.accessBasis !== 'history' ||
      grant.sourceChatKind !== 'direct' ||
      !grant.sourceChatId ||
      !grant.sourceViewerChatGrantId ||
      !grant.sourceCallSessionId ||
      !callSessionVault ||
      !isEName(callSessionVault)
    ) {
      return undefined;
    }

    const cached = cachedMeshengerPlaybackGrantUrls.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return { url: cached.url, cacheHit: true };
    }
    if (cached) cachedMeshengerPlaybackGrantUrls.delete(cacheKey);

    const pending = pendingMeshengerPlaybackGrantResolutions.get(cacheKey);
    const resolution =
      pending ??
      requestMeshengerPlaybackGrant({
        config: this.config.playbackGrantConfig,
        request: {
          viewerEName: grant.eName,
          viewerChatGrantId: grant.sourceViewerChatGrantId,
          callSessionVault,
          callSessionEnvelopeId: grant.sourceCallSessionId,
          sourceChatId: grant.sourceChatId,
          fileUri: grant.fileUri,
        },
        ...(signal ? { signal } : {}),
        now: this.now,
      }).finally(() => {
        pendingMeshengerPlaybackGrantResolutions.delete(cacheKey);
      });
    if (!pending) pendingMeshengerPlaybackGrantResolutions.set(cacheKey, resolution);

    const result = await awaitMediaResolution(resolution, signal);
    if (result.kind === 'granted') {
      cacheMeshengerPlaybackGrantUrl(
        cacheKey,
        result.mediaUrl,
        Math.min(grant.expiresAt, result.expiresAt),
      );
      return { url: result.mediaUrl, cacheHit: false };
    }
    if (
      result.kind === 'not_configured' ||
      result.kind === 'not_eligible' ||
      result.kind === 'not_found'
    ) {
      return undefined;
    }
    if (result.kind === 'cancelled') {
      throwIfMediaResolutionAborted(signal);
    }
    throw new MeshengerVideoLibraryError(
      'This shared source is temporarily unavailable. Please try again.',
      'remote_unavailable',
      503,
    );
  }

  async resolveMediaUrl(
    user: ViewerIdentity,
    streamId: string,
    options?: MediaResolutionOptions,
  ): Promise<string> {
    throwIfMediaResolutionAborted(options?.signal);
    const { grant, file } = this.requireBoundPlayableStreamGrant(user, streamId);
    const cacheKey = mediaUrlCacheKey(grant);
    const priority = options?.priority ?? 'interactive';
    const hasRecentSharedAuthorizationReceipt =
      grant.accessScope === 'shared' && options?.hasRecentSharedAuthorizationReceipt === true;
    reportMediaAuthorizationContext(options, mediaAuthorizationTimingContext(grant, priority));
    const interactive = priority === 'interactive';
    const sourceReadPolicy: SourceReadPolicy =
      priority === 'interactive'
        ? 'interactive'
        : priority === 'warmup'
          ? 'warmup-cancellable'
          : options?.signal
            ? 'background-cancellable'
            : 'backoff';
    const sharedProbeOptions = {
      priority:
        priority === 'interactive'
          ? ('interactive' as const)
          : priority === 'warmup'
            ? ('warmup' as const)
            : ('background' as const),
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    const timing = createMediaResolutionTiming();
    // Route-level diagnostics must retain the completed phases when a source
    // read rejects. The observer is safe and fixed-schema, while the caller
    // still receives the original authorization/source error unchanged.
    const reportTimingOnFailure = async <T>(
      operation: Promise<T>,
      observedTiming: MediaResolutionTiming = timing,
    ): Promise<T> => {
      try {
        return await operation;
      } catch (error) {
        reportMediaResolutionTiming(options, observedTiming);
        throw error;
      }
    };
    // For canonical shared call recordings, the source bridge can validate the
    // exact viewer Chat / source Chat / CallSession / File relationship and
    // issue the private URL in one source-local request. Try it *before* the
    // Vidak-side exact proof so the configured fast path is actually the
    // default on a cold Watch, not merely a fallback after several remote
    // reads have already completed. A bridge miss still falls through to the
    // existing verifier below; it never becomes authorization by itself.
    const fastSharedCallPlayback =
      grant.accessScope === 'shared' && !hasRecentSharedAuthorizationReceipt
        ? await reportTimingOnFailure(
            measureMediaResolutionPhase(timing, 'sharedAccessVerificationMs', () =>
              this.resolveFastSharedCallPlayback(grant, cacheKey, priority, options?.signal),
            ),
          )
        : undefined;
    if (fastSharedCallPlayback) {
      timing.mediaUrlCacheHit = fastSharedCallPlayback.cacheHit;
      reportMediaResolutionTiming(options, timing);
      return fastSharedCallPlayback.url;
    }
    const exactSharedCallAuthorization =
      grant.accessScope === 'shared' && !hasRecentSharedAuthorizationReceipt
        ? await reportTimingOnFailure(
            measureMediaResolutionPhase(timing, 'sharedAccessVerificationMs', () =>
              this.resolveExactSharedCallAuthorization(user, grant, priority, options?.signal),
            ),
          )
        : hasRecentSharedAuthorizationReceipt
          ? 'verified'
          : 'not_eligible';
    if (exactSharedCallAuthorization === 'denied') {
      throw new MeshengerVideoLibraryError(
        'This source cannot be played until its access is verified.',
        'authorization_denied',
        403,
      );
    }
    if (exactSharedCallAuthorization === 'retry') {
      throw new MeshengerVideoLibraryError(
        'This shared source is temporarily unavailable. Please try again.',
        'remote_unavailable',
        503,
      );
    }
    const cached = cachedMediaUrls.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (grant.accessScope === 'shared' && exactSharedCallAuthorization !== 'verified') {
        const probes = sharedStreamProbes(grant);
        const needsCurrentProof =
          probes.length > 0 &&
          !probes.some((source) => hasVerifiedSharedAccess(user.eName, source));
        if (interactive && needsCurrentProof) {
          // This branch used to begin the potentially slow remote proof before
          // telling resumable inventory to yield. It is only a scheduling
          // hint: the authoritative proof below still decides whether this
          // cached redirect can be returned.
          reserveInteractivePlayback(interactiveCachedSharedProofReservationMs, this.now());
        }
        // A cached redirect is not itself authorization. Reuse a short
        // positive source proof when available, otherwise verify the share
        // before reusing a URL that may outlive a revoked membership.
        await reportTimingOnFailure(
          measureMediaResolutionPhase(timing, 'sharedAccessVerificationMs', () =>
            this.requirePlayableStreamGrant(user, streamId, sharedProbeOptions),
          ),
        );
      }
      timing.mediaUrlCacheHit = true;
      reportMediaResolutionTiming(options, timing);
      return cached.url;
    }
    if (cached) cachedMediaUrls.delete(cacheKey);
    const pendingKey = `${cacheKey}\u0000${sourceReadPolicyPendingKey(sourceReadPolicy)}`;
    const pending = pendingMediaUrlResolutions.get(pendingKey);
    if (pending) {
      const mediaUrl = await reportTimingOnFailure(
        awaitMediaResolution(pending.promise, options?.signal),
        pending.timing,
      );
      reportMediaResolutionTiming(options, pending.timing);
      return mediaUrl;
    }
    // Only a source-cache miss opens remote work. Avoid extending global
    // preview priority for every normal media range while retaining a longer,
    // source-scoped quiet window for a genuinely cold video start.
    const playbackStartedAt = interactive ? this.now() : 0;
    const playbackUntil = interactive ? playbackStartedAt + interactiveVaultReservationMs : 0;
    if (interactive) {
      // Poster extraction is resumable. Stop it briefly so its ffmpeg and
      // source read cannot compete with an explicit first playback request.
      reserveInteractivePlayback(interactivePreviewReservationMs, playbackStartedAt);
      reserveInteractiveSourceWork(
        file.ownerEName,
        interactiveVaultReservationMs,
        playbackStartedAt,
      );
      reserveInteractiveVaultGate(file.ownerEName, playbackUntil, playbackStartedAt);
    }

    const resolution = (async () => {
      throwIfMediaResolutionAborted(options?.signal);
      if (interactive) {
        // This is a scheduling hint for resumable inventory work, not an
        // authorization decision. Do not put an extra database round trip on
        // the first-byte path; the in-process reservation above is immediate.
        void this.jobStore.setVaultGate(file.ownerEName, playbackUntil).catch(() => undefined);
      }
      // An eVault directory mapping is not authorization evidence. Start this
      // cacheable lookup after the signed viewer-bound grant has been checked,
      // but overlap it with the authoritative shared-source check below. The
      // File dereference and any media URL cache write remain strictly after a
      // successful authorization result.
      const vaultResolution = this.resolveEVaultLookup(
        file.ownerEName,
        sourceReadPolicy,
        options?.signal,
      );
      // If the authorization check rejects first, retain a rejection handler
      // for the speculative directory lookup. Awaiting the original promise
      // below still preserves its normal error when authorization succeeds.
      void vaultResolution.catch(() => undefined);
      if (grant.accessScope === 'shared' && exactSharedCallAuthorization !== 'verified') {
        // The documented File dereference endpoint resolves a File URI; it
        // is not a documented source-membership check. Verify the signed
        // source context before either returning or caching its redirect.
        await measureMediaResolutionPhase(timing, 'sharedAccessVerificationMs', () =>
          this.requirePlayableStreamGrant(user, streamId, sharedProbeOptions),
        );
      }
      // A user has explicitly requested this source. The foreground request
      // uses its own priority key, while an interactive shared-source probe
      // above can reuse this same directory lookup.
      const initialVault = await measureMediaResolutionPhase(
        timing,
        'eVaultResolutionMs',
        () => vaultResolution,
      );
      const resolveFromVault = async (vault: ResolvedVault): Promise<string> => {
        const dereferenced = await measureMediaResolutionPhase(
          timing,
          'directFileDereferenceMs',
          () =>
            this.tryDereferenceFileMediaUrl(
              vault,
              file.metaEnvelopeId,
              sourceReadPolicy,
              options?.signal,
            ),
        );
        return (
          dereferenced ??
          (await this.resolveMediaUrlFromEnvelope(
            vault,
            file.metaEnvelopeId,
            user.eName,
            sourceReadPolicy,
            options?.signal,
            timing,
          ))
        );
      };
      let mediaUrl: string;
      try {
        mediaUrl = await resolveFromVault(initialVault.vault);
      } catch (error) {
        // Directory data is cacheable but a source may move. A 404 from a
        // previously cached vault is the one unambiguous signal to refresh its
        // mapping. Do that once only, after the ordinary shared-access check
        // above has succeeded; the refreshed mapping is still not permission
        // and the File/metadata access check remains authoritative.
        if (!initialVault.cacheHit || !isStaleEVaultNotFound(error)) throw error;
        const freshVault = await measureMediaResolutionPhase(timing, 'eVaultResolutionMs', () =>
          this.resolveEVaultLookup(file.ownerEName, sourceReadPolicy, options?.signal, {
            forceRefresh: true,
          }),
        );
        mediaUrl = await resolveFromVault(freshVault.vault);
      }
      cacheMediaUrl(cacheKey, mediaUrl, grant.expiresAt);
      return mediaUrl;
    })().finally(() => {
      pendingMediaUrlResolutions.delete(pendingKey);
    });
    pendingMediaUrlResolutions.set(pendingKey, { promise: resolution, timing });
    const mediaUrl = await reportTimingOnFailure(awaitMediaResolution(resolution, options?.signal));
    reportMediaResolutionTiming(options, timing);
    return mediaUrl;
  }

  /**
   * Prepares the viewer-bound File redirect after a viewer signals intent to
   * watch. This reads no video bytes. Its return value is server-only: Route
   * Handlers may place it in the encrypted cross-replica handoff, but must
   * never serialize it to a browser response.
   */
  async authorizePlayableStream(
    user: ViewerIdentity,
    streamId: string,
    options?: MediaResolutionOptions,
  ): Promise<string> {
    return this.resolveMediaUrl(user, streamId, options);
  }

  /**
   * Dereferences the canonical W3DS File URI after shared source access has
   * been verified. eVault returns a fresh media redirect here, avoiding a
   * GraphQL metadata read on the playback path. Older deployments that do
   * not expose this endpoint retain the existing metadata resolver as a safe
   * fallback.
   */
  private async tryDereferenceFileMediaUrl(
    vault: ResolvedVault,
    metaEnvelopeId: string,
    _policy: SourceReadPolicy,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    throwIfMediaResolutionAborted(signal);
    const endpointFallbackKey = `${vault.eVaultUri}\u0000endpoint`;
    const fileFallbackKey = `${vault.eVaultUri}\u0000${metaEnvelopeId}`;
    const fallbackUntil = Math.max(
      directFileFallbackPreferred.get(endpointFallbackKey) ?? 0,
      directFileFallbackPreferred.get(fileFallbackKey) ?? 0,
    );
    if (fallbackUntil && fallbackUntil > Date.now()) return undefined;
    if (fallbackUntil) {
      directFileFallbackPreferred.delete(endpointFallbackKey);
      directFileFallbackPreferred.delete(fileFallbackKey);
    }
    let response: Response;
    try {
      response = await fetch(
        new URL(`/files/${encodeURIComponent(metaEnvelopeId)}`, vault.eVaultUri),
        {
          method: 'GET',
          headers: {
            'X-ENAME': vault.ownerEName,
          },
          cache: 'no-store',
          redirect: 'manual',
          signal: sourceRequestSignal(directFileDereferenceTimeoutMs, signal),
        },
      );
    } catch {
      throwIfMediaResolutionAborted(signal);
      cacheDirectFileFallback(endpointFallbackKey, Date.now(), directFileTransientFallbackTtlMs);
      return undefined;
    }
    try {
      throwIfMediaResolutionAborted(signal);
      if (response.status !== 302) {
        // A known unsupported endpoint otherwise adds two seconds to every
        // new video before the documented GraphQL resolver runs. Only cache
        // explicit capability responses; temporary failures remain retryable.
        if ([405, 501].includes(response.status)) {
          cacheDirectFileFallback(endpointFallbackKey, Date.now());
        } else if (response.status === 404) {
          // A missing File is not evidence that the endpoint itself is absent.
          // Keep this fallback scoped to this record so another valid shared
          // video in the same eVault can still use the fast File redirect.
          cacheDirectFileFallback(fileFallbackKey, Date.now());
        } else if ([408, 429].includes(response.status) || response.status >= 500) {
          cacheDirectFileFallback(
            endpointFallbackKey,
            Date.now(),
            directFileTransientFallbackTtlMs,
          );
        }
        return undefined;
      }
      const location = response.headers.get('location');
      return location ? safeMediaUrl(location) : undefined;
    } finally {
      // This request is header-only. Releasing its body prevents a burst of
      // card authorizations from holding unnecessary upstream sockets.
      await response.body?.cancel().catch(() => undefined);
    }
  }

  private async resolveMediaUrlFromEnvelope(
    vault: ResolvedVault,
    metaEnvelopeId: string,
    actingEName: string,
    policy: SourceReadPolicy,
    signal?: AbortSignal,
    timing?: MediaResolutionTiming,
  ): Promise<string> {
    const envelope = await this.readEnvelope(
      vault.ownerEName,
      vault.eVaultUri,
      metaEnvelopeId,
      policy,
      actingEName,
      signal,
      timing,
    );
    const url = optionalString(envelope.parsed.publicUrl) ?? optionalString(envelope.parsed.url);
    if (!url) {
      throw new MeshengerVideoLibraryError(
        'The video file is unavailable.',
        'remote_rejected',
        404,
      );
    }
    return safeMediaUrl(url);
  }

  /**
   * Returns the authorized file identity for a playable stream.
   *
   * Preview responses are private, but can outlive the original capture. Reuse
   * the playback authorization path so cached shared previews never bypass a
   * current source-access check.
   */
  async inspectPlayableStream(
    user: ViewerIdentity,
    streamId: string,
    options?: Pick<MediaResolutionOptions, 'priority' | 'signal'>,
  ): Promise<{ fileUri: string }> {
    const { grant } = await this.requirePlayableStreamGrant(user, streamId, options);
    return { fileUri: grant.fileUri };
  }

  /**
   * Confirms that a short-lived stream token belongs to this viewer without
   * dereferencing its source. Callers may use this only for local metadata;
   * actual media access must go through inspectPlayableStream.
   */
  inspectBoundStream(user: ViewerIdentity, streamId: string): { fileUri: string } {
    const { grant } = this.requireBoundStreamGrant(user, streamId);
    return { fileUri: grant.fileUri };
  }

  /** Reissues an expired viewer-bound stream; the next File request rechecks access. */
  async renewPlayableStream(user: ViewerIdentity, streamId: string): Promise<string> {
    const bound = this.requireBoundPlayableStreamGrant(user, streamId, { allowExpired: true });
    const now = this.now();
    const cached = renewedStreams.get(streamId);
    if (cached && cached.eName === bound.grant.eName && cached.expiresAt > now) {
      return cached.streamId;
    }
    const { grant } = bound;
    const renewedStreamId = createMeshengerVideoStreamId(
      {
        ...grant,
        expiresAt: now + streamLifetimeMs,
      },
      this.config.signingSecret,
    );
    cacheRenewedStream(
      streamId,
      {
        eName: grant.eName,
        streamId: renewedStreamId,
        expiresAt: now + streamLifetimeMs,
      },
      now,
    );
    return renewedStreamId;
  }

  /**
   * Drops a cached signed source after the upstream reports an expired or denied
   * media URL. The next request resolves the File envelope again.
   */
  async invalidateMediaUrl(user: ViewerIdentity, streamId: string): Promise<void> {
    const { grant, file } = this.requireBoundPlayableStreamGrant(user, streamId);
    const cacheKey = mediaUrlCacheKey(grant);
    cachedMediaUrls.delete(cacheKey);
    cachedMeshengerPlaybackGrantUrls.delete(cacheKey);
    const cachedVault = cachedEVaultResolutions.get(normalizeEName(file.ownerEName))?.vault;
    if (cachedVault) {
      // A transient File redirect failure can have made the GraphQL URL the
      // preferred fallback for this eVault. An upstream rejection is an
      // explicit recovery signal, so clear that non-authorizing fast-path
      // hint as well and let the next resolution try /files/:id once more.
      directFileFallbackPreferred.delete(`${cachedVault.eVaultUri}\u0000endpoint`);
      directFileFallbackPreferred.delete(`${cachedVault.eVaultUri}\u0000${file.metaEnvelopeId}`);
    }
    // A denied/missing upstream can also mean the owner's eVault moved after
    // the directory mapping was cached. Force the recovery path to ask the
    // registry again instead of retaining a stale destination for its TTL.
    cachedEVaultResolutions.delete(normalizeEName(file.ownerEName));
    // An upstream 401/403/404 can mean its authorization changed. Do not let
    // the short shared-source optimization mask that signal on the recovery
    // attempt.
    for (const source of sharedStreamProbes(grant)) {
      forgetVerifiedSharedAccess(user.eName, source);
    }
  }

  private requireBoundStreamGrant(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
    options?: { allowExpired?: boolean },
  ): { grant: StreamGrant; file: NonNullable<ReturnType<typeof parseW3dsFileUri>> } {
    const grant = verifyMeshengerVideoStreamId(streamId, this.config.signingSecret, options);
    const eName = requireEName(user.eName);
    const file = parseW3dsFileUri(grant.fileUri);
    if (grant.eName !== eName || !file) {
      throw new MeshengerVideoLibraryError(
        'This source cannot be played until its access is verified.',
        'authorization_denied',
        403,
      );
    }
    return { grant, file };
  }

  /**
   * Validates the signed viewer-bound grant and its source context without
   * treating a chat or group metadata mirror as the media authority. The
   * eVault File request below is made on behalf of the viewer and remains the
   * final access check for every stream open.
   */
  private requireBoundPlayableStreamGrant(
    user: Pick<AuthUser, 'eName'>,
    streamId: string,
    options?: { allowExpired?: boolean },
  ): { grant: StreamGrant; file: NonNullable<ReturnType<typeof parseW3dsFileUri>> } {
    const bound = this.requireBoundStreamGrant(user, streamId, options);
    const { grant, file } = bound;
    if (grant.accessScope === 'personal') {
      if (!sameEName(file.ownerEName, user.eName)) {
        throw new MeshengerVideoLibraryError(
          'This source cannot be played until its access is verified.',
          'authorization_denied',
          403,
        );
      }
      return bound;
    }

    const sourceSpaceKey = grant.sourceSpaceKey;
    const accessBasis = grant.accessBasis;
    if (
      !sourceSpaceKey ||
      !isEName(sourceSpaceKey) ||
      (accessBasis !== 'personal' &&
        accessBasis !== 'membership' &&
        accessBasis !== 'history' &&
        accessBasis !== 'reference') ||
      (accessBasis === 'history' && !grant.sourceChatId) ||
      (accessBasis === 'reference' && (!grant.sourceReferenceId || !grant.sourceReferenceFileId))
    ) {
      throw new MeshengerVideoLibraryError(
        'This source cannot be played until its access is verified.',
        'authorization_denied',
        403,
      );
    }
    if (accessBasis === 'personal' && !sameEName(sourceSpaceKey, user.eName)) {
      throw new MeshengerVideoLibraryError(
        'This source cannot be played until its access is verified.',
        'authorization_denied',
        403,
      );
    }
    return bound;
  }

  private async requirePlayableStreamGrant(
    user: ViewerIdentity,
    streamId: string,
    options?: {
      allowExpired?: boolean;
      priority?: MediaResolutionPriority;
      signal?: AbortSignal;
    },
  ): Promise<{ grant: StreamGrant; file: NonNullable<ReturnType<typeof parseW3dsFileUri>> }> {
    throwIfMediaResolutionAborted(options?.signal);
    const bound = this.requireBoundPlayableStreamGrant(user, streamId, options);
    const { grant } = bound;
    if (grant.accessScope === 'personal') {
      return bound;
    }
    const probes = sharedStreamProbes(grant);
    if (probes.some((source) => hasVerifiedSharedAccess(user.eName, source))) return bound;

    const priority = options?.priority ?? 'interactive';
    const sourceReadPolicy: SourceReadPolicy =
      priority === 'interactive'
        ? 'interactive'
        : priority === 'warmup'
          ? 'warmup-cancellable'
          : options?.signal
            ? 'background-cancellable'
            : 'backoff';
    if (probes.length && priority === 'interactive') {
      // Every remote shared-access proof below needs the platform credential,
      // but a GroupManifest proof cannot request it until the source eVault
      // directory lookup has completed. Start that safe, process-wide
      // credential refresh now so its latency overlaps the required directory
      // read. This never authorizes a File, returns a source URL, or starts a
      // media request; the normal proof and File gate remain mandatory.
      //
      // Background and cancellable-hover work deliberately do not take this
      // speculative path: they can wait for the normal GraphQL read and must
      // not create a competing credential refresh while Watch is opening.
      void this.getPlatformToken(sourceReadPolicy).catch(() => undefined);
    }
    const startSourceProof = (source: SharedSpaceProbe): Promise<SharedSpaceAccess> =>
      // A cancellable preview must neither own the interactive pending key nor
      // make Watch wait for its retry. Completed positive source proofs remain
      // safely reusable because their key includes the exact source context.
      coalesceSharedAccessProbe(
        user.eName,
        source,
        async () => {
          if (priority !== 'interactive') {
            return options?.signal
              ? this.probeSharedSpaceAccess(user, source, sourceReadPolicy, {
                  signal: options.signal,
                })
              : this.probeSharedSpaceAccess(user, source, sourceReadPolicy);
          }

          // Give every independent proof its own bounded child signal. The
          // caller's signal remains part of it, so cancellation still reaches
          // the remote request. A deadline is not evidence that access was
          // revoked, however, so translate only that internal abort into the
          // existing retry result rather than an authorization denial.
          const proofSignal = sourceRequestSignal(interactiveSharedProofTimeoutMs, options?.signal);
          try {
            return await this.probeSharedSpaceAccess(user, source, sourceReadPolicy, {
              signal: proofSignal,
            });
          } catch (error) {
            if (error instanceof MediaResolutionAbortedError && !options?.signal?.aborted) {
              return { access: 'retry', member: false };
            }
            throw error;
          }
        },
        Date.now(),
        () => Date.now(),
        { priority },
      );

    let retrying = false;
    if (grant.accessBasis === 'history' && priority === 'interactive') {
      // A historic share has two independent current proofs: the exact direct
      // Chat record and the source GroupManifest. Start both coalesced proofs
      // together and continue as soon as either one proves access. Do not
      // abort the other top-level operation: it may be shared by another
      // request and its completed positive result remains a safe short-lived
      // cache entry for the next Range request.
      const pending = new Map<number, Promise<{ index: number; access: SharedSpaceAccess }>>();
      for (const [index, source] of probes.entries()) {
        pending.set(
          index,
          // A source-proof failure is not authorization. Convert an unexpected
          // remote/probe failure into the same private, retryable result used
          // by normal source reads. This observes a losing concurrent history
          // probe after playback has already been authorized, so it cannot
          // become an unhandled rejection or leak source details.
          startSourceProof(source)
            .catch(() => ({ access: 'retry', member: false }) as const)
            .then((access) => ({ index, access })),
        );
      }
      while (pending.size) {
        const { index, access } = await Promise.race([...pending.values()]);
        pending.delete(index);
        // Probe helpers intentionally collapse an aborted background read into a
        // retry result for catalogue callers. A media-resolution caller owns an
        // explicit signal, so preserve that cancellation instead of surfacing a
        // misleading temporary-source error to the preview worker.
        throwIfMediaResolutionAborted(options?.signal);
        if (access.access === 'ok' && access.member) return bound;
        retrying ||= access.access === 'retry';
      }
    } else {
      for (const source of probes) {
        const access = await startSourceProof(source);
        // Probe helpers intentionally collapse an aborted background read into a
        // retry result for catalogue callers. A media-resolution caller owns an
        // explicit signal, so preserve that cancellation instead of surfacing a
        // misleading temporary-source error to the preview worker.
        throwIfMediaResolutionAborted(options?.signal);
        if (access.access === 'ok' && access.member) return bound;
        retrying ||= access.access === 'retry';
      }
    }
    if (retrying) {
      throw new MeshengerVideoLibraryError(
        'This shared source is temporarily unavailable. Please try again.',
        'remote_unavailable',
        503,
      );
    }
    throw new MeshengerVideoLibraryError(
      'This source cannot be played until its access is verified.',
      'authorization_denied',
      403,
    );
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
      toStreamId: (grantInput) =>
        createMeshengerVideoStreamId(
          {
            eName: input.eName,
            fileUri: grantInput.fileUri,
            accessScope: grantInput.accessScope,
            ...(grantInput.sourceSpaceKey ? { sourceSpaceKey: grantInput.sourceSpaceKey } : {}),
            ...(grantInput.sourceChatId ? { sourceChatId: grantInput.sourceChatId } : {}),
            ...(grantInput.sourceViewerChatGrantId
              ? { sourceViewerChatGrantId: grantInput.sourceViewerChatGrantId }
              : {}),
            ...(grantInput.sourceCallSessionId
              ? { sourceCallSessionId: grantInput.sourceCallSessionId }
              : {}),
            ...(grantInput.sourceCallSessionVault
              ? { sourceCallSessionVault: grantInput.sourceCallSessionVault }
              : {}),
            ...(grantInput.sourceRecordingVault
              ? { sourceRecordingVault: grantInput.sourceRecordingVault }
              : {}),
            ...(grantInput.sourceChatKind ? { sourceChatKind: grantInput.sourceChatKind } : {}),
            ...(grantInput.sourceReferenceId
              ? { sourceReferenceId: grantInput.sourceReferenceId }
              : {}),
            ...(grantInput.sourceReferenceFileId
              ? { sourceReferenceFileId: grantInput.sourceReferenceFileId }
              : {}),
            ...(grantInput.accessBasis ? { accessBasis: grantInput.accessBasis } : {}),
            expiresAt: Date.now() + streamLifetimeMs,
          },
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
    options?: {
      drain?: boolean;
      maxWaves?: number;
      maxVaultsPerWave?: number;
      signal?: AbortSignal;
    },
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
      ...(options?.maxWaves !== undefined ? { maxWaves: options.maxWaves } : {}),
      ...(options?.maxVaultsPerWave !== undefined
        ? { maxVaultsPerWave: options.maxVaultsPerWave }
        : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
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
          appendRetained(
            messages,
            envelopes.map((message) => toMeshengerMessage(eName, message)),
            maxRetainedLibraryMessages,
          );
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
        vaultNotBefore: (vault, timestamp) => this.inventoryVaultNotBefore(vault, timestamp),
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
      maxWaves?: number;
      maxVaultsPerWave?: number;
      signal?: AbortSignal;
    },
  ): Promise<MeshengerLibrary> {
    const completeness =
      options?.accumulators?.completeness ?? createInventoryCompletenessTracker();
    const referenced = options?.accumulators?.referenced ?? new Set<string>();
    const found = options?.accumulators?.found ?? [];
    const conversations = options?.accumulators?.conversations ?? [];
    const messageRecords = options?.accumulators?.messages ?? [];
    const emitDone = options?.emitDone !== false;
    const inventorySignal = options?.signal;
    const inventoryRateLimit = inventorySourceReadPolicy(inventorySignal);
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
            sourceMetadata?: RecordValue;
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
    const deferredSpaces = new Set<string>();
    const openedGroups = new Map<string, { vault: ResolvedVault; member: boolean }>();
    const openedDirects = new Map<string, ResolvedVault>();
    const scheduledGroupFiles = new Set<string>();
    const scheduledGroupHistory = new Set<string>();
    const scheduledDirectHistory = new Set<string>();
    const scheduledFileReferences = new Set<string>();

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
      if (deferredSpaces.delete(key)) completeness.reopenDeferredSpace();
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
    // Viewer-vault Chat envelopes are current, per-conversation grants. Keep
    // their opaque IDs alongside the direct Chat ids so a later playback can
    // re-read exactly one grant instead of searching legacy chat history.
    const viewerDirectChatGrantIds = new Map<string, Map<string, string>>();
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
        (snapshotState.retrying ?? 0) === 0 &&
        (snapshotState.deferred ?? 0) === 0 &&
        !inventoryHasRateLimitedFalseComplete({
          status: 'complete',
          completeness: snapshotState,
        });
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
            deferredSpaces: [...deferredSpaces],
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
            scheduledFileReferences: [...scheduledFileReferences],
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
            viewerDirectChatGrantIds: [...viewerDirectChatGrantIds].map(([key, value]) => [
              key,
              [...value],
            ]),
            catalogueVersion: VIDEO_SPACE_CATALOGUE_VERSION,
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
    const restoreStringMapString = (value: unknown, target: Map<string, Map<string, string>>) => {
      if (!Array.isArray(value)) return;
      for (const entry of value) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1]))
          continue;
        const values = new Map<string, string>();
        for (const pair of entry[1]) {
          if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string')
            continue;
          values.set(pair[0], pair[1]);
        }
        if (values.size) target.set(entry[0], values);
      }
    };

    const existingJob = await this.jobStore.getByOwner(eName);
    let job =
      existingJob ??
      (await this.jobStore.createJob({
        ownerEName: eName,
        ownerEVaultUri: ownVault.eVaultUri,
      }));
    let drainFinished = job.ledger.drainFinished === true;
    // A deployment can land while a long-running inventory is partway through
    // its pages. Resume cursors from the old parser would preserve every
    // attachment it already skipped, so restart stale running jobs as well as
    // stale completed jobs. `restartCatalogueJob` retains visible cards.
    if (isStaleCatalogueVersion(job.ledger) && (drainFinished || hasCatalogueVersion(job.ledger))) {
      job = await this.restartCatalogueJob(job, ownVault.eVaultUri);
      drainFinished = false;
    }
    jobId = job.id;
    jobCreatedAt = job.createdAt;
    let savedQueue = Array.isArray(job.ledger.queue) ? (job.ledger.queue as SharedWork[]) : [];
    let openTasks = await this.jobStore.loadOpenTasks(job.id);
    // A previous worker can persist an incomplete catalogue after its queue and
    // task rows have both been lost. It was previously impossible to make
    // progress from this state: the scanner had no unsettled space to reseed,
    // so cards only reappeared after a manual Refresh. Restart the catalogue
    // while keeping its discovered records, then seed the root sources below.
    const hasLostWork =
      !drainFinished &&
      !job.completeness.complete &&
      job.completeness.retryNeeded &&
      savedQueue.length === 0 &&
      openTasks.length === 0 &&
      inventorySpacesClassified(job.completeness) < job.completeness.expected;
    if (hasLostWork) {
      // Operational marker only: deliberately omit account and source data.
      console.info('[inventory-recovery] restarted-lost-work');
      job = await this.restartCatalogueJob(job, ownVault.eVaultUri);
      drainFinished = false;
      jobId = job.id;
      jobCreatedAt = job.createdAt;
      savedQueue = [];
      openTasks = [];
    }
    const restoreJobLedger = () => {
      completeness.hydrate(job.completeness);
      Object.assign(counts, job.sourceCounts);
      if (Array.isArray(job.ledger.found)) found.push(...(job.ledger.found as DiscoveredVideo[]));
      appendRetained(conversations, job.conversations, maxRetainedLibraryConversations);
      appendRetained(messageRecords, job.messages, maxRetainedLibraryMessages);
      if (Array.isArray(job.ledger.remaining)) {
        for (const entry of job.ledger.remaining as [string, number][])
          remaining.set(entry[0], entry[1]);
      }
      restoreStringSet(job.ledger.settled, settled);
      restoreStringSet(job.ledger.failedSpaces, failedSpaces);
      restoreStringSet(job.ledger.deferredSpaces, deferredSpaces);
      restoreStringSet(job.ledger.scheduledAuthors, scheduledAuthors);
      restoreStringSet(job.ledger.scheduledGroupFiles, scheduledGroupFiles);
      restoreStringSet(job.ledger.scheduledGroupHistory, scheduledGroupHistory);
      restoreStringSet(job.ledger.scheduledDirectHistory, scheduledDirectHistory);
      restoreStringSet(job.ledger.scheduledFileReferences, scheduledFileReferences);
      restoreStringSet(job.ledger.referenced, referenced);
      restoreStringMapSet(job.ledger.scheduledGroupChats, scheduledGroupChats);
      restoreStringMapSet(job.ledger.scheduledDirectChats, scheduledDirectChats);
      restoreStringMapSet(job.ledger.historicalAuthors, historicalAuthors);
      restoreStringMapSet(job.ledger.referencedGroupChats, referencedGroupChats);
      restoreStringMapSet(job.ledger.referencedDirectChats, referencedDirectChats);
      restoreStringMapString(job.ledger.viewerDirectChatGrantIds, viewerDirectChatGrantIds);
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

    const repairRateLimitedTerminals = () => {
      if (failedSpaces.size === 0) return false;
      const state = completeness.snapshot();
      const settledCount = state.indexed + state.denied + state.missing;
      const shouldRepair =
        (state.failed ?? 0) > 0 &&
        settledCount < state.expected &&
        settledCount + (state.failed ?? 0) >= state.expected &&
        (state.retryRateLimited ?? 0) > 0;
      if (!shouldRepair) return false;
      while ((completeness.snapshot().failed ?? 0) > 0) completeness.unfailSpace();
      counts.failed = 0;
      const keysToReopen =
        failedSpaces.size > 0
          ? [...failedSpaces]
          : [...settled].filter(
              (key) => referencedGroupChats.has(key) || referencedDirectChats.has(key),
            );
      for (const key of keysToReopen) {
        failedSpaces.delete(key);
        settled.delete(key);
        deferredSpaces.add(key);
        if (!remaining.has(key)) remaining.set(key, 1);
        else remaining.set(key, (remaining.get(key) ?? 0) + 1);
        completeness.deferSpace();
      }
      return keysToReopen.length > 0;
    };

    if (
      drainFinished &&
      savedQueue.length === 0 &&
      openTasks.length === 0 &&
      (job.completeness.retrying ?? 0) === 0 &&
      (job.completeness.deferred ?? 0) === 0 &&
      !ledgerHasUnsettledSpaces(job.ledger) &&
      inventorySpacesClassified(job.completeness) >= job.completeness.expected &&
      !inventoryHasRateLimitedFalseComplete(job)
    ) {
      restoreJobLedger();
      completeness.markScanFinished();
      return snapshot('done');
    }
    restoreJobLedger();
    const repaired = repairRateLimitedTerminals();
    if (openTasks.length > 0) {
      for (const task of openTasks) queue.push(task.payload as unknown as SharedWork);
    } else if (savedQueue.length > 0) {
      queue.push(...savedQueue);
    } else if (
      repaired ||
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
    const rememberViewerDirectChatGrantId = (
      ownerEName: string,
      chatId: string,
      viewerChatGrantId: string | undefined,
    ) => {
      if (!viewerChatGrantId || sameEName(ownerEName, eName)) return;
      const grants = viewerDirectChatGrantIds.get(ownerEName) ?? new Map<string, string>();
      // Duplicate legacy Chat rows can point to the same direct conversation.
      // Each candidate is fully re-read and validated at playback; retaining
      // the first keeps the persisted checkpoint compact and deterministic.
      if (!grants.has(chatId)) grants.set(chatId, viewerChatGrantId);
      viewerDirectChatGrantIds.set(ownerEName, grants);
    };
    const viewerDirectChatGrantIdFor = (ownerEName: string, chatId: string) =>
      viewerDirectChatGrantIds.get(ownerEName)?.get(chatId);
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
    const enqueueFileReference = (
      target: FileRecordReferenceTarget,
      sourceSpaceKey: string,
      referenceId: string,
    ) => {
      // This exact File reference was just read from the viewer's own vault.
      // Playback re-reads and compares the same local envelope, canonical
      // owner, and canonical File id, so retain only that positive proof in
      // the existing short in-memory cache. References found in a group or
      // foreign vault never take this path.
      if (sameEName(sourceSpaceKey, eName)) {
        rememberVerifiedSharedAccess(eName, {
          eName: target.ownerEName,
          kind: 'reference',
          referenceId,
          fileId: target.metaEnvelopeId,
        });
      }
      const referenceKey = `${sourceSpaceKey}\u0000${referenceId}\u0000${target.fileUri}`;
      if (scheduledFileReferences.has(referenceKey)) return;
      scheduledFileReferences.add(referenceKey);
      queue.push({
        type: 'resolve-media',
        vaultKey: target.ownerEName,
        owner: target.ownerEName,
        eVaultUri: '',
        fileUri: target.fileUri,
        envelopeId: target.metaEnvelopeId,
        sourceId: 'file-reference',
        sourceSpaceKey,
        sourceMetadata: { type: 'file', sourceReferenceId: referenceId },
        attempts: 0,
      });
    };
    if (
      queue.length === 0 &&
      (repaired ||
        remaining.size > 0 ||
        inventorySpacesClassified(completeness.snapshot()) < job.completeness.expected)
    ) {
      reseedUnsettledWork();
    }
    const ingestReferences = (envelopes: Envelope[]) => {
      const references = chatGrantsFromEnvelopes(envelopes, eName);
      this.rememberCurrentViewerDirectChatGrantProofs(eName, references);
      appendRetained(
        conversations,
        chatEnvelopesToConversations(eName, references, envelopes),
        maxRetainedLibraryConversations,
      );
      for (const reference of references) {
        completeness.recordGrant(reference.basis);
        if (reference.type === 'group' || !reference.type) {
          enqueueGroup(reference.groupEName, [reference.chatId]);
        }
        if (reference.type !== 'group') {
          rememberViewerDirectChatGrantId(
            reference.groupEName,
            reference.chatId,
            reference.viewerChatGrantId,
          );
          enqueueDirect(reference.groupEName, [reference.chatId]);
        }
      }
    };
    const ingestMessagePage = (
      sourceEName: string,
      chatId: string,
      items: Envelope[],
      vault?: ResolvedVault,
      sourceViewerChatGrantId?: string,
    ) => {
      found.push(
        ...this.discoverMessageVideos(
          items,
          referenced,
          eName,
          sourceEName,
          completeness,
          (fileUri, envelopeId, sourceMetadata) => {
            if (!vault) return;
            const vaultKey = parseW3dsFileUri(fileUri)?.ownerEName ?? vault.ownerEName;
            queue.push({
              type: 'resolve-media',
              vaultKey,
              owner: vault.ownerEName,
              eVaultUri: vault.eVaultUri,
              fileUri,
              envelopeId,
              sourceMetadata,
              sourceId: `message:${sourceEName}:${chatId}`,
              sourceSpaceKey: sourceEName,
              attempts: 0,
            });
          },
          chatId,
          sourceViewerChatGrantId,
        ),
      );
      appendRetained(
        messageRecords,
        items.map((message) => toMeshengerMessage(sourceEName, message)),
        maxRetainedLibraryMessages,
      );
      mergeAuthorMap(historicalAuthors, authorsFromMessages(items));
      for (const author of historicalAuthors.get(chatId) ?? []) {
        if (sameEName(author, sourceEName) || sameEName(author, eName)) continue;
        enqueueAuthor(author, chatId);
      }
    };

    const requestedPageKeys = new Set<string>();
    const trackPageRequest = (item: SharedWork) => {
      const key = workKey(item);
      if (requestedPageKeys.has(key)) return;
      requestedPageKeys.add(key);
      completeness.recordPageRequest();
    };

    const claimed = await this.jobStore.tryClaimDrain(jobId, this.now());
    if (!claimed) return snapshot('batch');
    try {
      await persistCheckpoint();
      // Keep each selected source item visible to the cancellation boundary.
      // `drainFairVaultQueue` removes a selected item before invoking its
      // callback, so an aborted source read must put that exact cursor back
      // before this durable checkpoint is written.
      const activeInventorySourceReads = new Set<Promise<void>>();
      let keepDraining = true;
      while (keepDraining) {
        try {
          await drainFairVaultQueue(
            queue,
            async (item) => {
              if (inventorySignal?.aborted) {
                upsertWork(queue, item, workKey);
                return;
              }
              const operation = (async () => {
                trackPageRequest(item);
                if (item.type === 'owned-source') {
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(
                        ownVault.ownerEName,
                        ownVault.eVaultUri,
                        item.ontologyId,
                        undefined,
                        {
                          maxPages: 1,
                          after: item.after,
                          rateLimit: inventoryRateLimit,
                          ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                        rateLimit: inventoryRateLimit,
                        ...(inventorySignal ? { signal: inventorySignal } : {}),
                      })),
                    );
                  } else if (item.ontologyId === fileOntology) {
                    found.push(
                      ...this.discoverFileVideos(
                        eName,
                        page.value.items,
                        referenced,
                        eName,
                        (target, referenceId) => enqueueFileReference(target, eName, referenceId),
                      ),
                    );
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
                    {
                      rateLimit: inventoryRateLimit,
                      ...(inventorySignal ? { signal: inventorySignal } : {}),
                    },
                  );
                  snapshot('batch');
                  return;
                }
                if (item.type === 'chats' || item.type === 'messages') {
                  const ontologyId = item.type === 'chats' ? chatOntology : messageOntology;
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(
                        ownVault.ownerEName,
                        ownVault.eVaultUri,
                        ontologyId,
                        undefined,
                        {
                          maxPages: 1,
                          after: item.after,
                          rateLimit: inventoryRateLimit,
                          ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                        (fileUri, envelopeId, sourceMetadata) => {
                          queue.push({
                            type: 'resolve-media',
                            vaultKey: parseW3dsFileUri(fileUri)?.ownerEName ?? ownVault.ownerEName,
                            owner: ownVault.ownerEName,
                            eVaultUri: ownVault.eVaultUri,
                            fileUri,
                            envelopeId,
                            sourceMetadata,
                            sourceId: 'owned-message',
                            sourceSpaceKey: eName,
                            attempts: 0,
                          });
                        },
                      ),
                    );
                    appendRetained(
                      messageRecords,
                      page.value.items.map((message) => toMeshengerMessage(eName, message)),
                      maxRetainedLibraryMessages,
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
                  const referencedIds =
                    referencedGroupChats.get(item.groupEName) ?? new Set<string>();
                  const space = await this.readGroupSpace({
                    viewerEName: eName,
                    groupEName: item.groupEName,
                    chatIds: referencedIds,
                    referenced,
                    historicalAuthors,
                    completeness,
                    rateLimit: inventoryRateLimit,
                    ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  openedGroups.set(item.groupEName, {
                    vault,
                    member: space.currentMember === true,
                  });
                  appendRetained(
                    conversations,
                    space.conversations,
                    maxRetainedLibraryConversations,
                  );
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
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(item.owner, item.eVaultUri, chatOntology, undefined, {
                        maxPages: 1,
                        after: item.after,
                        rateLimit: inventoryRateLimit,
                        ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  const page = await this.readInventorySource(
                    () =>
                      this.listMessagesForChat(
                        item.owner,
                        item.eVaultUri,
                        item.chatId,
                        undefined,
                        inventoryRateLimit,
                        {
                          maxPages: 1,
                          after: item.after,
                          ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(item.owner, item.eVaultUri, messageOntology, undefined, {
                        maxPages: 1,
                        after: item.after,
                        rateLimit: inventoryRateLimit,
                        ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                      (fileUri, envelopeId, sourceMetadata) => {
                        queue.push({
                          type: 'resolve-media',
                          vaultKey: parseW3dsFileUri(fileUri)?.ownerEName ?? item.owner,
                          owner: item.owner,
                          eVaultUri: item.eVaultUri,
                          fileUri,
                          envelopeId,
                          sourceMetadata,
                          sourceId: `group-history:${item.spaceKey}`,
                          sourceSpaceKey: item.groupEName,
                          attempts: 0,
                        });
                      },
                    ),
                  );
                  appendRetained(
                    messageRecords,
                    page.value.items.map((message) => toMeshengerMessage(item.groupEName, message)),
                    maxRetainedLibraryMessages,
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
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(
                        item.owner,
                        item.eVaultUri,
                        groupManifestOntology,
                        undefined,
                        {
                          maxPages: 1,
                          after: item.after,
                          rateLimit: inventoryRateLimit,
                          ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(
                        item.owner,
                        item.eVaultUri,
                        callSessionOntology,
                        undefined,
                        {
                          maxPages: 1,
                          after: item.after,
                          rateLimit: inventoryRateLimit,
                          ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  recordCoveragePage(completeness, callSessionOntology);
                  found.push(
                    ...(await this.discoverCallVideos({
                      viewerEName: eName,
                      sourceEName: item.groupEName,
                      sourceEVaultUri: item.eVaultUri,
                      sourceChatKind: 'group',
                      calls: page.value.items,
                      chatIds: new Set(item.chatIds),
                      referenced,
                      rateLimit: inventoryRateLimit,
                      ...(inventorySignal ? { signal: inventorySignal } : {}),
                    })),
                  );
                  continueOrFinishPage(item.spaceKey, item, page.value);
                  snapshot('batch');
                  return;
                }

                if (item.type === 'group-files') {
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(item.owner, item.eVaultUri, item.ontologyId, undefined, {
                        maxPages: 1,
                        after: item.after,
                        rateLimit: inventoryRateLimit,
                        ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                      ...this.discoverRawFileVideos(
                        item.owner,
                        page.value.items,
                        referenced,
                        eName,
                      ),
                    );
                  } else {
                    found.push(
                      ...this.discoverFileVideos(
                        item.owner,
                        page.value.items,
                        referenced,
                        eName,
                        (target, referenceId) =>
                          enqueueFileReference(target, item.groupEName, referenceId),
                      ),
                    );
                  }
                  continueOrFinishPage(item.spaceKey, item, page.value);
                  snapshot('batch');
                  return;
                }

                if (item.type === 'direct-open') {
                  const referencedIds =
                    referencedDirectChats.get(item.ownerEName) ?? new Set<string>();
                  const viewerChatGrantIds = viewerDirectChatGrantIds.get(item.ownerEName);
                  const space = await this.readDirectSpace({
                    viewerEName: eName,
                    ownerEName: item.ownerEName,
                    chatIds: referencedIds,
                    ...(viewerChatGrantIds ? { viewerChatGrantIds } : {}),
                    referenced,
                    completeness,
                    rateLimit: inventoryRateLimit,
                    ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  appendRetained(
                    conversations,
                    space.conversations,
                    maxRetainedLibraryConversations,
                  );
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
                  const page = await this.readInventorySource(
                    () =>
                      this.listMessagesForChat(
                        item.owner,
                        item.eVaultUri,
                        item.chatId,
                        undefined,
                        inventoryRateLimit,
                        {
                          maxPages: 1,
                          after: item.after,
                          ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  ingestMessagePage(
                    item.ownerEName,
                    item.chatId,
                    page.value.items,
                    {
                      ownerEName: item.owner,
                      eVaultUri: item.eVaultUri,
                    },
                    viewerDirectChatGrantIdFor(item.ownerEName, item.chatId),
                  );
                  continueOrFinishPage(item.spaceKey, item, page.value);
                  snapshot('batch');
                  return;
                }

                if (item.type === 'direct-chats') {
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(item.owner, item.eVaultUri, chatOntology, undefined, {
                        maxPages: 1,
                        after: item.after,
                        rateLimit: inventoryRateLimit,
                        ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(item.owner, item.eVaultUri, messageOntology, undefined, {
                        maxPages: 1,
                        after: item.after,
                        rateLimit: inventoryRateLimit,
                        ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                      (fileUri, envelopeId, sourceMetadata) => {
                        queue.push({
                          type: 'resolve-media',
                          vaultKey: parseW3dsFileUri(fileUri)?.ownerEName ?? item.owner,
                          owner: item.owner,
                          eVaultUri: item.eVaultUri,
                          fileUri,
                          envelopeId,
                          sourceMetadata,
                          sourceId: `direct-history:${item.spaceKey}`,
                          sourceSpaceKey: item.ownerEName,
                          attempts: 0,
                        });
                      },
                      undefined,
                      undefined,
                      viewerDirectChatGrantIds.get(item.ownerEName),
                    ),
                  );
                  appendRetained(
                    messageRecords,
                    page.value.items.map((message) => toMeshengerMessage(item.ownerEName, message)),
                    maxRetainedLibraryMessages,
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
                  const page = await this.readInventorySource(
                    () =>
                      this.listEnvelopes(
                        item.owner,
                        item.eVaultUri,
                        callSessionOntology,
                        undefined,
                        {
                          maxPages: 1,
                          after: item.after,
                          rateLimit: inventoryRateLimit,
                          ...(inventorySignal ? { signal: inventorySignal } : {}),
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
                  recordCoveragePage(completeness, callSessionOntology);
                  const sourceViewerChatGrantIds = viewerDirectChatGrantIds.get(item.ownerEName);
                  found.push(
                    ...(await this.discoverCallVideos({
                      viewerEName: eName,
                      sourceEName: item.ownerEName,
                      sourceEVaultUri: item.eVaultUri,
                      sourceChatKind: 'direct',
                      calls: page.value.items,
                      chatIds: new Set(item.chatIds),
                      ...(sourceViewerChatGrantIds ? { sourceViewerChatGrantIds } : {}),
                      referenced,
                      rateLimit: inventoryRateLimit,
                      ...(inventorySignal ? { signal: inventorySignal } : {}),
                    })),
                  );
                  continueOrFinishPage(item.spaceKey, item, page.value);
                  snapshot('batch');
                  return;
                }

                if (item.type !== 'author-messages') return;

                const authorRead = await this.readInventorySource(
                  async () => {
                    const authorVault = await this.resolveEVault(
                      item.authorEName,
                      inventoryRateLimit,
                      inventorySignal,
                    );
                    return this.listMessagesForChat(
                      authorVault.ownerEName,
                      authorVault.eVaultUri,
                      item.chatId,
                      undefined,
                      inventoryRateLimit,
                      {
                        maxPages: 1,
                        after: item.after,
                        ...(inventorySignal ? { signal: inventorySignal } : {}),
                      },
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
                      (fileUri, envelopeId, sourceMetadata) => {
                        queue.push({
                          type: 'resolve-media',
                          vaultKey: parseW3dsFileUri(fileUri)?.ownerEName ?? item.authorEName,
                          owner: item.authorEName,
                          eVaultUri: '',
                          fileUri,
                          envelopeId,
                          sourceMetadata,
                          sourceId: `author-messages:${item.chatId}`,
                          sourceSpaceKey: item.authorEName,
                          attempts: 0,
                        });
                      },
                      item.chatId,
                      viewerDirectChatGrantIds.get(item.authorEName)?.get(item.chatId),
                    ),
                  );
                  appendRetained(
                    messageRecords,
                    authorRead.value.items.map((message) =>
                      toMeshengerMessage(item.authorEName, message),
                    ),
                    maxRetainedLibraryMessages,
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
              })();
              activeInventorySourceReads.add(operation);
              try {
                await operation;
              } catch (error) {
                if (isInventoryScanCancellation(error, inventorySignal)) {
                  upsertWork(queue, item, workKey);
                }
                throw error;
              } finally {
                activeInventorySourceReads.delete(operation);
              }
            },
            {
              vaultKey: (item) => inventoryVaultKey(item, ownVault.ownerEName),
              priority: (item) => inventoryWorkPriority(item.type),
              now: this.now,
              maxVaultsPerWave: options?.maxVaultsPerWave ?? sharedSpaceConcurrency,
              ...(options?.maxWaves !== undefined ? { maxWaves: options.maxWaves } : {}),
              vaultNotBefore: (vault, timestamp) => this.inventoryVaultNotBefore(vault, timestamp),
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
        } catch (error) {
          if (!isInventoryScanCancellation(error, inventorySignal)) throw error;
          // Other concurrently selected vault reads may still be unwinding.
          // Wait for their callbacks to restore their cursors before saving.
          await Promise.allSettled([...activeInventorySourceReads]);
          await persistCheckpoint();
          return snapshot('batch');
        }
        if (queue.length > 0) {
          // The durable queue still has ready work. Yield it to the next pump
          // instead of holding the drain lock through an unbounded history.
          await persistCheckpoint();
          return snapshot('batch');
        }
        if (remaining.size === 0) {
          keepDraining = false;
          break;
        }
        reseedUnsettledWork();
        dedupeWork(queue, workKey);
        completeness.reconcileRetrying(queue.filter((item) => item.attempts > 0).length);
        if (queue.length === 0) {
          for (const spaceKey of remaining.keys()) {
            if (!settled.has(spaceKey) && !deferredSpaces.has(spaceKey)) failOpenTerminal(spaceKey);
          }
          keepDraining = false;
          break;
        }
      }
      const finished = completeness.snapshot();
      if (
        remaining.size === 0 &&
        inventorySpacesClassified(finished) >= finished.expected &&
        (finished.retrying ?? 0) === 0 &&
        (finished.deferred ?? 0) === 0 &&
        !inventoryHasRateLimitedFalseComplete({ status: 'complete', completeness: finished })
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
    if (failure === 'rate_limited') {
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
    const cap = failure === 'rejected' ? maxRejectedAttempts : maxRejectedAttempts;
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
    options?: { rateLimit?: SourceReadPolicy; signal?: AbortSignal },
  ): Promise<Envelope | undefined> {
    if (source.parsed.isReference !== true) {
      return { ...source, sourceCallSessionVault: sourceEName };
    }
    const owner = optionalString(source.parsed.canonicalOwnerEName);
    const id = optionalString(source.parsed.canonicalEnvelopeId);
    if (!owner || !id || !isEName(owner)) return undefined;
    const vault =
      owner === sourceEName
        ? { ownerEName: sourceEName, eVaultUri: sourceEVaultUri }
        : await this.resolveEVault(owner, options?.rateLimit ?? 'fail-fast', options?.signal);
    const canonical = await this.readEnvelope(
      vault.ownerEName,
      vault.eVaultUri,
      id,
      options?.rateLimit ?? 'fail-fast',
      undefined,
      options?.signal,
    );
    return { ...canonical, sourceCallSessionVault: vault.ownerEName };
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
    rateLimit?: SourceReadPolicy;
    signal?: AbortSignal;
    silenceRetries?: boolean;
    mode?: 'open' | 'full';
  }): Promise<GroupDiscovery> {
    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messageRecords: MeshengerMessage[] = [];
    const pendingAuthors: Array<{ authorEName: string; chatId: string }> = [];
    const failureTracker = input.silenceRetries ? undefined : input.completeness;
    const rateLimit = input.rateLimit ?? inventorySourceReadPolicy(input.signal);
    const read = input.signal ? this.readInventorySource.bind(this) : this.readSource.bind(this);
    const vaultRead = await read(
      () => this.resolveEVault(input.groupEName, rateLimit, input.signal),
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
      const manifestsRead = await read(
        () =>
          this.listEnvelopes(owner, groupEVaultUri, groupManifestOntology, undefined, {
            maxPages: 1,
            rateLimit,
            ...(input.signal ? { signal: input.signal } : {}),
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
      if (currentMember) {
        this.rememberCurrentViewerGroupMembershipProof(input.viewerEName, input.groupEName);
      }
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
      const chatsRead = await read(
        () =>
          this.listEnvelopes(owner, groupEVaultUri, chatOntology, undefined, {
            maxPages: 1,
            rateLimit,
            ...(input.signal ? { signal: input.signal } : {}),
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
          sourceChatKind: 'group',
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
            undefined,
            undefined,
            chatId,
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
                undefined,
                undefined,
                chatId,
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
    const viewerChatGrantIdsByOwner = new Map<string, Map<string, string>>();
    for (const reference of references) {
      if (reference.groupEName === viewerEName) continue;
      if (reference.type === 'group') continue;
      const chatIds = byOwner.get(reference.groupEName) ?? new Set<string>();
      chatIds.add(reference.chatId);
      byOwner.set(reference.groupEName, chatIds);
      if (reference.viewerChatGrantId) {
        const grantIds = viewerChatGrantIdsByOwner.get(reference.groupEName) ?? new Map();
        // A source can have mirrored/legacy duplicate Chat rows. Either one
        // is re-read and fully validated before playback, so retain the first
        // opaque current envelope rather than expanding the stream grant.
        if (!grantIds.has(reference.chatId)) {
          grantIds.set(reference.chatId, reference.viewerChatGrantId);
        }
        viewerChatGrantIdsByOwner.set(reference.groupEName, grantIds);
      }
    }

    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messages: MeshengerMessage[] = [];
    const owners = [...byOwner];
    await mapPool(owners, sharedSpaceConcurrency, async ([ownerEName, chatIds]) => {
      completeness.expectSpace();
      const viewerChatGrantIds = viewerChatGrantIdsByOwner.get(ownerEName);
      const space = await this.readDirectSpace({
        viewerEName,
        ownerEName,
        chatIds,
        ...(viewerChatGrantIds ? { viewerChatGrantIds } : {}),
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
    viewerChatGrantIds?: ReadonlyMap<string, string>;
    referenced: Set<string>;
    completeness: InventoryCompletenessTracker;
    rateLimit?: SourceReadPolicy;
    signal?: AbortSignal;
    silenceRetries?: boolean;
    mode?: 'open' | 'full';
  }): Promise<GroupDiscovery> {
    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messages: MeshengerMessage[] = [];
    const failureTracker = input.silenceRetries ? undefined : input.completeness;
    const rateLimit = input.rateLimit ?? inventorySourceReadPolicy(input.signal);
    const read = input.signal ? this.readInventorySource.bind(this) : this.readSource.bind(this);
    const vaultRead = await read(
      () => this.resolveEVault(input.ownerEName, rateLimit, input.signal),
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
    const chatsRead = await read(
      () =>
        this.listEnvelopes(owner, eVaultUri, chatOntology, undefined, {
          maxPages: input.mode === 'open' ? 1 : maxPages,
          rateLimit,
          ...(input.signal ? { signal: input.signal } : {}),
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
          undefined,
          undefined,
          chatId,
          input.viewerChatGrantIds?.get(chatId),
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
          sourceChatKind: 'direct',
          calls: callsRead.value,
          chatIds: input.chatIds,
          ...(input.viewerChatGrantIds
            ? { sourceViewerChatGrantIds: input.viewerChatGrantIds }
            : {}),
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
    sourceChatKind,
    calls,
    chatId,
    chatIds,
    sourceViewerChatGrantIds,
    referenced,
    signal,
    rateLimit,
  }: {
    viewerEName: string;
    sourceEName: string;
    sourceEVaultUri: string;
    sourceChatKind?: 'direct' | 'group';
    calls: Envelope[];
    chatId?: string;
    chatIds?: ReadonlySet<string>;
    sourceViewerChatGrantIds?: ReadonlyMap<string, string>;
    referenced: Set<string>;
    signal?: AbortSignal;
    rateLimit?: SourceReadPolicy;
  }): Promise<DiscoveredVideo[]> {
    const resolved: Envelope[] = [];
    for (const source of calls) {
      const callRead = await this.readInventorySource(
        () =>
          this.resolveCall(sourceEName, sourceEVaultUri, source, {
            ...(rateLimit ? { rateLimit } : {}),
            ...(signal ? { signal } : {}),
          }),
        undefined,
      );
      if (callRead.value) resolved.push(callRead.value);
    }
    return discoverCallRecordingVideos({
      viewerEName,
      sourceEName,
      calls: resolved,
      referenced,
      ...(sourceChatKind ? { sourceChatKind } : {}),
      ...(chatId ? { chatId } : {}),
      ...(chatIds ? { chatIds } : {}),
      ...(sourceViewerChatGrantIds ? { sourceViewerChatGrantIds } : {}),
    });
  }

  private discoverMessageVideos(
    messages: Envelope[],
    referenced: Set<string>,
    viewerEName: string,
    sourceSpaceKey?: string,
    completeness?: InventoryCompletenessTracker,
    onResolve?: (fileUri: string, envelopeId: string, sourceMetadata: RecordValue) => void,
    sourceChatIdHint?: string,
    sourceViewerChatGrantIdHint?: string,
    sourceViewerChatGrantIds?: ReadonlyMap<string, string>,
  ): DiscoveredVideo[] {
    const accepted: Envelope[] = [];
    for (const message of messages) {
      const sourceMetadata = compactMediaSourceMetadata(message.parsed);
      // A Messages-by-Chat response is already bound to this exact Chat.
      // Preserve that trusted route context even if an older payload carries
      // a conflicting alias, so deferred File resolution and the eventual
      // stream grant revalidate the same direct conversation.
      const effectiveChatId = sourceChatIdHint ?? optionalString(sourceMetadata.chatId);
      const viewerChatGrantId =
        effectiveChatId && sourceChatIdHint && effectiveChatId === sourceChatIdHint
          ? (sourceViewerChatGrantIdHint ?? sourceViewerChatGrantIds?.get(effectiveChatId))
          : effectiveChatId
            ? sourceViewerChatGrantIds?.get(effectiveChatId)
            : undefined;
      const metadataWithChatGrant =
        effectiveChatId && viewerChatGrantId
          ? {
              ...sourceMetadata,
              ...(sourceChatIdHint ? { chatId: sourceChatIdHint } : {}),
              sourceViewerChatGrantId: viewerChatGrantId,
            }
          : sourceChatIdHint
            ? { ...sourceMetadata, chatId: sourceChatIdHint }
            : sourceMetadata;
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
        onResolve?.(decision.fileUri, message.id, metadataWithChatGrant);
        continue;
      }
      const type = optionalString(message.parsed.type)?.toLowerCase();
      if (
        onResolve &&
        (type === 'file' || type === 'video' || type === 'circle' || !type) &&
        decision.reason === 'missing_w3ds_file_uri'
      ) {
        onResolve('', message.id, metadataWithChatGrant);
        continue;
      }
      completeness?.recordUnresolved(decision.reason);
    }
    return discoverVideoMessageVideos(
      accepted,
      referenced,
      viewerEName,
      sourceSpaceKey,
      sourceChatIdHint,
      sourceViewerChatGrantIdHint,
      sourceViewerChatGrantIds,
    );
  }

  private async resolveQueuedMedia(
    item: {
      fileUri: string;
      envelopeId?: string;
      owner: string;
      eVaultUri: string;
      vaultKey: string;
      sourceSpaceKey: string;
      sourceId: string;
      sourceMetadata?: RecordValue;
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
    options?: { signal?: AbortSignal; rateLimit?: SourceReadPolicy },
  ): Promise<void> {
    // A deferred File lookup may resolve a foreign canonical record. Retain
    // only the conversation id that originally authorized the reference so
    // its eventual playback grant can be checked against that same source.
    const sourceChatId = optionalString(item.sourceMetadata?.chatId);
    const sourceViewerChatGrantId = optionalString(item.sourceMetadata?.sourceViewerChatGrantId);
    const sourceReferenceId = optionalString(item.sourceMetadata?.sourceReferenceId);
    const parsedFile = parseW3dsFileUri(item.fileUri);
    const envelopeId = parsedFile?.metaEnvelopeId ?? item.envelopeId;
    const ownerHint = parsedFile?.ownerEName ?? item.owner;
    if (!envelopeId) {
      completeness.recordUnresolved('missing_w3ds_file_uri');
      return;
    }
    const vaultRead = await this.readInventorySource(async () => {
      const vault =
        ownerHint === item.owner && item.eVaultUri
          ? { ownerEName: item.owner, eVaultUri: item.eVaultUri }
          : await this.resolveEVault(ownerHint, options?.rateLimit ?? 'fail-fast', options?.signal);
      const envelope = await this.readEnvelope(
        vault.ownerEName,
        vault.eVaultUri,
        envelopeId,
        options?.rateLimit ?? 'fail-fast',
        undefined,
        options?.signal,
      );
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
    if (item.sourceId === 'file-reference') {
      const canonical = this.discoverRawFileVideos(
        vaultRead.value.vault.ownerEName,
        [resolved],
        referenced,
        viewerEName,
      );
      const records =
        canonical.length > 0
          ? canonical
          : this.discoverFileVideos(
              vaultRead.value.vault.ownerEName,
              [resolved],
              referenced,
              viewerEName,
            );
      if (records.length === 0) {
        const contentType =
          optionalString(resolved.parsed.contentType) ?? optionalString(resolved.parsed.mimeType);
        const canonicalMedia = classifyAuthorizedMedia({
          payload: { type: 'file', ...resolved.parsed, mediaUri: item.fileUri },
          vaultOwnerEName: vaultRead.value.vault.ownerEName,
          ...(contentType ? { resolvedContentType: contentType } : {}),
          resolvedOntology: resolved.ontology,
        });
        if (canonicalMedia.status === 'exclude') {
          discardFileReferencePlaceholder(found, item.fileUri);
          return;
        }
        completeness.recordUnresolved('resolver_unavailable');
        return;
      }
      const canonicalOwnerEName = vaultRead.value.vault.ownerEName;
      const viewerOwnedReference =
        Boolean(sourceReferenceId) && sameEName(item.sourceSpaceKey, viewerEName);
      found.push(
        ...records.map((record) => ({
          ...record,
          // A reference stored in the viewer's own vault is its own durable
          // authorization proof. Foreign/group references keep the source
          // space that exposed them and stay membership-gated.
          sourceSpaceKey:
            record.accessScope === 'personal'
              ? item.sourceSpaceKey
              : viewerOwnedReference
                ? canonicalOwnerEName
                : item.sourceSpaceKey,
          ...(sourceChatId ? { sourceChatId } : {}),
          ...(sourceChatId && sourceViewerChatGrantId ? { sourceViewerChatGrantId } : {}),
          ...(viewerOwnedReference && sourceReferenceId ? { sourceReferenceId } : {}),
          ...(viewerOwnedReference ? { sourceReferenceFileId: envelopeId } : {}),
          accessBasis:
            record.accessScope === 'personal'
              ? ('personal' as const)
              : viewerOwnedReference
                ? ('reference' as const)
                : ('membership' as const),
        })),
      );
      return;
    }
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
          options,
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
                ...resolved.parsed,
                ...item.sourceMetadata,
                type: 'file',
                mediaUri: decision.fileUri,
                ...(record(resolved.parsed.file) || record(item.sourceMetadata?.file)
                  ? {
                      file: {
                        ...record(resolved.parsed.file),
                        ...record(item.sourceMetadata?.file),
                      },
                    }
                  : {}),
              },
            },
          ],
          referenced,
          viewerEName,
          item.sourceSpaceKey,
          optionalString(item.sourceMetadata?.chatId),
          optionalString(item.sourceMetadata?.sourceViewerChatGrantId),
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
    onReference?: (target: FileRecordReferenceTarget, referenceId: string) => void,
  ): DiscoveredVideo[] {
    for (const file of files) {
      const target = fileRecordReferenceTarget(file);
      if (target) onReference?.(target, file.id);
    }
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
    rateLimit: SourceReadPolicy = 'fail-fast',
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
    options?: { rethrowInventoryCancellation?: boolean },
  ): Promise<{ value: T; failure?: SourceFailure; retryAfterMs?: number }> {
    try {
      return { value: await read() };
    } catch (error) {
      if (options?.rethrowInventoryCancellation && error instanceof MediaResolutionAbortedError) {
        throw error;
      }
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

  /**
   * Cancellation is a scheduling signal for the durable inventory only. It
   * must reach the checkpointing boundary instead of becoming a retry, deny,
   * or failed source outcome.
   */
  private async readInventorySource<T>(
    read: () => Promise<T>,
    fallback: T,
    completeness?: InventoryCompletenessTracker,
  ): Promise<{ value: T; failure?: SourceFailure; retryAfterMs?: number }> {
    return this.readSource(read, fallback, completeness, { rethrowInventoryCancellation: true });
  }

  private async listEnvelopes(
    owner: string,
    eVaultUri: string,
    ontologyId: string,
    completeness?: InventoryCompletenessTracker,
    options?: {
      maxPages?: number;
      after?: string | null;
      rateLimit?: SourceReadPolicy;
      signal?: AbortSignal;
    },
  ): Promise<{ items: Envelope[]; complete: boolean; endCursor?: string }> {
    throwIfMediaResolutionAborted(options?.signal);
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
          undefined,
          options?.signal,
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
    rateLimit: SourceReadPolicy = 'fail-fast',
    options?: { maxPages?: number; after?: string | null; signal?: AbortSignal },
  ): Promise<{ items: Envelope[]; complete: boolean; endCursor?: string }> {
    throwIfMediaResolutionAborted(options?.signal);
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
          undefined,
          options?.signal,
        );
        return record(data.metaEnvelopes);
      },
      mapEdge: envelopeFromEdge,
    });
    if (!page.complete) completeness?.markRetry();
    return page;
  }

  /**
   * Finds the one Chat or Chat-reference that authorizes a shared playback
   * request. Normal playback uses the indexed exact query. A bounded legacy
   * scan is retained only for older eVaults that have not indexed these
   * documented Chat fields yet, so an optimization can never hide a valid
   * existing share.
   */
  private async findChatAuthorizationEnvelopes(
    owner: string,
    eVaultUri: string,
    chatId: string,
    rateLimit: SourceReadPolicy = 'fail-fast',
    signal?: AbortSignal,
  ): Promise<Envelope[]> {
    throwIfMediaResolutionAborted(signal);
    let exact: Envelope[] = [];
    try {
      const data = await this.graphql(
        owner,
        eVaultUri,
        exactChatAuthorizationQuery,
        {
          ontologyId: chatOntology,
          chatId,
          first: 8,
        },
        rateLimit,
        undefined,
        signal,
      );
      exact = asArray(record(data.metaEnvelopes)?.edges)
        .map(envelopeFromEdge)
        .filter((item): item is Envelope => item !== undefined);
    } catch (error) {
      // Compatibility fallback below. Preserve temporary availability/rate
      // failures so the player can retry instead of starting a deep scan.
      const failure = sourceFailureClass(error);
      if (failure === 'fatal' || isRetryFailure(failure)) throw error;
    }
    if (exact.some((item) => chatAuthorizationMatches(item, chatId))) return exact;
    return (
      await this.listEnvelopes(owner, eVaultUri, chatOntology, undefined, {
        maxPages: 3,
        rateLimit,
        ...(signal ? { signal } : {}),
      })
    ).items;
  }

  private async readEnvelope(
    owner: string,
    eVaultUri: string,
    id: string,
    rateLimit: SourceReadPolicy = 'fail-fast',
    actingEName?: string,
    signal?: AbortSignal,
    timing?: MediaResolutionTiming,
  ): Promise<Envelope> {
    const data = await this.graphql(
      owner,
      eVaultUri,
      readQuery,
      { id },
      rateLimit,
      actingEName,
      signal,
      timing,
    );
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

  private async resolveEVault(
    eName: string,
    rateLimit: SourceReadPolicy = 'fail-fast',
    signal?: AbortSignal,
  ): Promise<ResolvedVault> {
    return (await this.resolveEVaultLookup(eName, rateLimit, signal)).vault;
  }

  /**
   * Resolves non-authorizing registry directory data while retaining whether a
   * caller used a completed cache entry. The latter lets the playback path
   * recover once from a moved cached eVault without treating a cache hit as
   * source permission.
   */
  private async resolveEVaultLookup(
    eName: string,
    rateLimit: SourceReadPolicy = 'fail-fast',
    signal?: AbortSignal,
    options?: { forceRefresh?: boolean },
  ): Promise<ResolvedEVaultLookup> {
    throwIfMediaResolutionAborted(signal);
    const requested = normalizeEName(eName);
    const now = Date.now();
    const cached = options?.forceRefresh ? undefined : cachedEVaultResolutions.get(requested);
    if (cached && cached.expiresAt > now) return { vault: cached.vault, cacheHit: true };
    if (cached) cachedEVaultResolutions.delete(requested);
    // A durable inventory lease is independently cancellable. Sharing its
    // pending resolver would let aborting one job reject another job's source
    // lookup, so keep these requests out of the process-wide pending map.
    const pendingKey =
      rateLimit === 'inventory-cancellable'
        ? undefined
        : `${requested}\u0000${sourceReadPolicyPendingKey(rateLimit)}${
            options?.forceRefresh ? '\u0000fresh' : ''
          }`;
    const pending = pendingKey ? pendingEVaultResolutions.get(pendingKey) : undefined;
    if (pending) return { vault: await awaitMediaResolution(pending, signal), cacheHit: false };
    const resolution = this.resolveEVaultUncached(requested, rateLimit, signal)
      .then((vault) => {
        cacheEVaultResolution(requested, vault, Date.now());
        return vault;
      })
      .finally(() => {
        if (pendingKey) pendingEVaultResolutions.delete(pendingKey);
      });
    if (pendingKey) pendingEVaultResolutions.set(pendingKey, resolution);
    return { vault: await awaitMediaResolution(resolution, signal), cacheHit: false };
  }

  /** Uses the eVault URI issued in the authenticated session when available. */
  private async resolveViewerEVault(
    user: ViewerIdentity,
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
  ): Promise<ResolvedVault> {
    throwIfMediaResolutionAborted(signal);
    const ownerEName = requireEName(user.eName);
    if (user.eVaultUri?.trim()) {
      return { ownerEName, eVaultUri: httpUrl(user.eVaultUri) };
    }
    return this.resolveEVault(ownerEName, rateLimit, signal);
  }

  private async resolveEVaultUncached(
    requested: string,
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
  ): Promise<ResolvedVault> {
    const url = new URL('/resolve', this.config.registryBaseUrl);
    url.searchParams.set('w3id', requested);
    const resolved = record(await this.requestJson(url, { method: 'GET' }, rateLimit, signal));
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
    rateLimit: SourceReadPolicy = 'fail-fast',
    actingEName?: string,
    signal?: AbortSignal,
    timing?: MediaResolutionTiming,
  ): Promise<RecordValue> {
    throwIfMediaResolutionAborted(signal);
    const platformToken = await measureMediaResolutionPhase(timing, 'platformTokenMs', () =>
      // Interactive credentials remain process-wide and reusable. A
      // cancellable preview, however, owns its cold credential request so an
      // aborted hover cannot leave a retry running after the preview is gone.
      awaitMediaResolution(this.getPlatformToken(rateLimit, signal), signal),
    );
    throwIfMediaResolutionAborted(signal);
    const body = record(
      await measureMediaResolutionPhase(timing, 'metadataReadMs', () =>
        this.requestJson(
          new URL('/graphql', eVaultUri),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-ENAME': owner,
              Authorization: `Bearer ${platformToken}`,
              ...(actingEName ? { 'X-ON-BEHALF-OF': normalizeEName(actingEName) } : {}),
            },
            body: JSON.stringify({ query, variables }),
          },
          rateLimit,
          signal,
        ),
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
  private async getPlatformToken(
    rateLimit: SourceReadPolicy = 'fail-fast',
    signal?: AbortSignal,
  ): Promise<string> {
    const cacheKey = `${this.config.registryBaseUrl}\u0000${this.config.platformName}`;
    const now = Date.now();
    const cached = cachedPlatformTokens.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.token;
    if (cached) cachedPlatformTokens.delete(cacheKey);
    const tokenPolicy: SourceReadPolicy =
      rateLimit === 'inventory-cancellable'
        ? // Inventory cancellation applies to its source reads only. The
          // registry credential is process-wide, so keep it on the ordinary
          // non-cancellable fail-fast key that a foreground listing can reuse.
          'fail-fast'
        : rateLimit === 'background-cancellable' || rateLimit === 'warmup-cancellable'
          ? 'backoff'
          : rateLimit;
    const callerOwnsCancellableToken =
      Boolean(signal) &&
      (rateLimit === 'background-cancellable' || rateLimit === 'warmup-cancellable');
    if (callerOwnsCancellableToken) {
      // Do not put a cancellable hover/warmup credential request in the
      // process-wide pending map. If its source read is cancelled, its retry
      // budget must stop with that read instead of waking later and competing
      // with an interactive Watch request.
      throwIfMediaResolutionAborted(signal);
      const token = await this.requestPlatformToken(tokenPolicy, signal);
      cachePlatformToken(cacheKey, token, Date.now());
      return token;
    }
    const pendingKey = `${cacheKey}\u0000${sourceReadPolicyPendingKey(tokenPolicy)}`;
    const pending = pendingPlatformTokens.get(pendingKey);
    if (pending) return pending;

    // `createEVaultVideoLibrary()` is request-scoped so it can bind playback
    // to the current viewer. The registry platform credential is not
    // viewer-specific, though. Share this short-lived server-only request so
    // cold shared videos do not each add another registry round trip before
    // their eVault metadata can be read.
    const controller = new AbortController();
    const tokenRequest = this.requestPlatformToken(tokenPolicy, controller.signal)
      .then((token) => {
        cachePlatformToken(cacheKey, token, Date.now());
        return token;
      })
      .finally(() => {
        // A test cache reset can abort this request and let a newer request
        // claim the same key before this finally handler runs.
        if (pendingPlatformTokenControllers.get(pendingKey) === controller) {
          pendingPlatformTokens.delete(pendingKey);
          pendingPlatformTokenControllers.delete(pendingKey);
        }
      });
    pendingPlatformTokens.set(pendingKey, tokenRequest);
    pendingPlatformTokenControllers.set(pendingKey, controller);
    return tokenRequest;
  }

  private async requestPlatformToken(
    rateLimit: SourceReadPolicy,
    signal?: AbortSignal,
  ): Promise<string> {
    const payload = record(
      await this.requestJson(
        new URL('/platforms/certification', this.config.registryBaseUrl),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: this.config.platformName }),
        },
        rateLimit,
        signal,
      ),
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
    rateLimit: SourceReadPolicy = 'fail-fast',
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempt = async (): Promise<unknown> => {
      throwIfMediaResolutionAborted(signal);
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          cache: 'no-store',
          signal: sourceRequestSignal(requestTimeoutMs, signal),
        });
      } catch {
        throwIfMediaResolutionAborted(signal);
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
      if ([408, 425, 500, 502, 503, 504].includes(response.status)) {
        throw new MeshengerVideoLibraryError(
          'The W3DS video source is temporarily unavailable.',
          'remote_unavailable',
          503,
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
        throwIfMediaResolutionAborted(signal);
        throw new MeshengerVideoLibraryError(
          'The W3DS video source returned invalid data.',
          'remote_rejected',
          502,
        );
      }
    };
    if (rateLimit === 'fail-fast' || rateLimit === 'inventory-cancellable') return attempt();
    return retryWithExponentialBackoff(attempt, {
      isRetryable: (error) =>
        error instanceof MeshengerVideoLibraryError &&
        (error.code === 'rate_limited' || error.code === 'remote_unavailable'),
      maxAttempts: 4,
      baseMs: 250,
      capMs: 4_000,
      retryAfterMs: (error) =>
        error instanceof MeshengerVideoLibraryError ? error.retryAfterMs : undefined,
      sleep: (ms) => sleepForMediaResolution(ms, signal),
    });
  }
}

export function createMeshengerVideoLibrary(
  env: Record<string, string | undefined> = process.env,
  options?: {
    jobStore?: InventoryJobStore;
    viewerChatGrantPointerStore?: ViewerChatGrantPointerStore;
    now?: () => number;
  },
): MeshengerVideoLibrary {
  const registry = env.W3DS_REGISTRY_BASE_URL?.trim();
  const signingSecret = env.W3DS_AUTH_JWT_SECRET;
  const playbackGrantConfig = readMeshengerPlaybackGrantConfig(env);
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
      ...(playbackGrantConfig ? { playbackGrantConfig } : {}),
    },
    options,
  );
}

/** Test helper; production caches expire automatically and are never globally reset. */
export function resetMeshengerVideoLibraryCachesForTests(): void {
  cachedMediaUrls.clear();
  cachedMeshengerPlaybackGrantUrls.clear();
  pendingMeshengerPlaybackGrantResolutions.clear();
  interactiveVaultGates.clear();
  pendingMediaUrlResolutions.clear();
  directFileFallbackPreferred.clear();
  setViewerChatGrantPointerStoreForTests();
  cachedEVaultResolutions.clear();
  pendingEVaultResolutions.clear();
  cachedPlatformTokens.clear();
  for (const controller of pendingPlatformTokenControllers.values()) controller.abort();
  pendingPlatformTokenControllers.clear();
  pendingPlatformTokens.clear();
  renewedStreams.clear();
  resetBackgroundWorkPriorityForTests();
}

function cachePlatformToken(cacheKey: string, token: string, now: number): void {
  if (cachedPlatformTokens.size >= maxCachedPlatformTokens) {
    const oldest = cachedPlatformTokens.keys().next().value;
    if (oldest) cachedPlatformTokens.delete(oldest);
  }
  cachedPlatformTokens.set(cacheKey, { token, expiresAt: now + platformTokenCacheTtlMs });
}

function hasReusableSharedProof(value: unknown): boolean {
  const item = record(value);
  const sourceSpaceKey = optionalString(item?.sourceSpaceKey);
  const accessBasis = optionalString(item?.accessBasis);
  if (!sourceSpaceKey) return false;
  if (accessBasis === 'membership') return true;
  if (accessBasis === 'history') return Boolean(optionalString(item?.sourceChatId));
  return (
    accessBasis === 'reference' &&
    Boolean(optionalString(item?.sourceReferenceId)) &&
    Boolean(optionalString(item?.sourceReferenceFileId))
  );
}

export function createMeshengerVideoStreamId(grant: StreamGrant, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', streamGrantKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(grant), 'utf8'), cipher.final()]);
  return [
    streamGrantVersion,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function verifyMeshengerVideoStreamId(
  value: string,
  secret: string,
  options?: { allowExpired?: boolean },
): StreamGrant {
  const parsed = decodeMeshengerVideoStreamGrant(value, secret);
  const grant = record(parsed);
  const eName = optionalString(grant?.eName);
  const fileUri = optionalString(grant?.fileUri);
  const expiresAt = number(grant?.expiresAt);
  const accessScope = optionalString(grant?.accessScope);
  const sourceSpaceKey = optionalString(grant?.sourceSpaceKey);
  const sourceChatId = optionalString(grant?.sourceChatId);
  const sourceViewerChatGrantId = optionalString(grant?.sourceViewerChatGrantId);
  const sourceCallSessionId = optionalString(grant?.sourceCallSessionId);
  const sourceCallSessionVault = optionalString(grant?.sourceCallSessionVault);
  const sourceRecordingVault = optionalString(grant?.sourceRecordingVault);
  const sourceChatKind = optionalString(grant?.sourceChatKind);
  const sourceReferenceId = optionalString(grant?.sourceReferenceId);
  const sourceReferenceFileId = optionalString(grant?.sourceReferenceFileId);
  const accessBasis = optionalString(grant?.accessBasis);
  if (
    !eName ||
    !fileUri ||
    (accessScope !== 'personal' && accessScope !== 'shared') ||
    expiresAt === undefined ||
    !isEName(eName) ||
    !parseW3dsFileUri(fileUri)
  )
    invalidStream();
  if (
    accessScope === 'shared' &&
    (!sourceSpaceKey ||
      !isEName(sourceSpaceKey) ||
      (accessBasis !== 'personal' &&
        accessBasis !== 'membership' &&
        accessBasis !== 'history' &&
        accessBasis !== 'reference') ||
      (accessBasis === 'history' && !sourceChatId) ||
      (accessBasis === 'reference' && (!sourceReferenceId || !sourceReferenceFileId)))
  )
    invalidStream();
  if (expiresAt <= Date.now() && !options?.allowExpired)
    throw new MeshengerVideoLibraryError(
      'This video link has expired. Refresh the library and try again.',
      'stream_expired',
      401,
    );
  return {
    eName,
    fileUri,
    accessScope,
    ...(sourceSpaceKey ? { sourceSpaceKey } : {}),
    ...(sourceChatId ? { sourceChatId } : {}),
    ...(sourceViewerChatGrantId ? { sourceViewerChatGrantId } : {}),
    ...(sourceCallSessionId ? { sourceCallSessionId } : {}),
    ...(sourceCallSessionVault ? { sourceCallSessionVault } : {}),
    ...(sourceRecordingVault ? { sourceRecordingVault } : {}),
    ...(sourceChatKind === 'direct' || sourceChatKind === 'group' ? { sourceChatKind } : {}),
    ...(sourceReferenceId ? { sourceReferenceId } : {}),
    ...(sourceReferenceFileId ? { sourceReferenceFileId } : {}),
    ...(accessBasis ? { accessBasis: accessBasis as VideoAccessBasis } : {}),
    expiresAt,
  };
}

/**
 * New stream grants are sealed with AES-GCM. The legacy signed form remains
 * readable until outstanding personal-player links expire after deployment.
 */
function decodeMeshengerVideoStreamGrant(value: string, secret: string): unknown {
  const parts = value.split('.');
  if (parts[0] === streamGrantVersion) {
    const [, ivValue, ciphertextValue, tagValue, ...rest] = parts;
    if (!ivValue || !ciphertextValue || !tagValue || rest.length) invalidStream();
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        streamGrantKey(secret),
        Buffer.from(ivValue, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(ciphertextValue, 'base64url')),
          decipher.final(),
        ]).toString('utf8'),
      );
    } catch {
      invalidStream();
    }
  }
  const [encoded, signature, ...rest] = parts;
  if (!encoded || !signature || rest.length) invalidStream();
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  )
    invalidStream();
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    invalidStream();
  }
}

function streamGrantKey(secret: string): Buffer {
  return createHash('sha256').update(`vidak-stream-grant:${secret}`).digest();
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

/** A cached directory destination can safely be retried only after a 404. */
function isStaleEVaultNotFound(error: unknown): boolean {
  return error instanceof MeshengerVideoLibraryError && error.code === 'not_found';
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
    return [
      {
        groupEName: ownerEName,
        chatId,
        basis: 'reference',
        viewerChatGrantId: envelope.id,
        ...(type ? { type } : {}),
      },
    ];
  }
  const grants: ChatReference[] = [];
  const canonicalOwner = optionalString(payload.canonicalOwnerEName);
  const canonicalOwnerEName = canonicalOwner ? asEName(canonicalOwner) : undefined;
  if (canonicalOwnerEName && !sameEName(canonicalOwnerEName, viewerEName)) {
    grants.push({
      groupEName: canonicalOwnerEName,
      chatId,
      basis: 'official',
      viewerChatGrantId: envelope.id,
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
      viewerChatGrantId: envelope.id,
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
function chatAuthorizationMatches(envelope: Envelope, chatId: string): boolean {
  return [
    envelope.id,
    optionalString(envelope.parsed.id),
    optionalString(envelope.parsed.chatId),
    optionalString(envelope.parsed.canonicalChatId),
  ].some((value) => value === chatId);
}
/** A direct source envelope can only add a positive authorization proof. */
function sourceChatEnvelopeIncludesViewer(
  envelope: Envelope,
  chatId: string,
  viewerEName: string,
): boolean {
  if (
    envelope.ontology !== chatOntology ||
    envelope.parsed.isReference === true ||
    !chatAuthorizationMatches(envelope, chatId)
  ) {
    return false;
  }
  return asArray(envelope.parsed.participantIds).some(
    (participant) => typeof participant === 'string' && sameEName(participant, viewerEName),
  );
}

/** A viewer-vault Chat hint is only a positive direct-share proof. */
function viewerChatGrantEnvelopeMatchesSource(
  envelope: Envelope,
  source: { eName: string; chatId: string },
  viewerEName: string,
): boolean {
  if (envelope.ontology !== chatOntology) return false;
  return chatGrantFromEnvelope(envelope, viewerEName).some(
    (grant) => sameEName(grant.groupEName, source.eName) && grant.chatId === source.chatId,
  );
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
function combineSharedAccess(
  first: SharedSpaceAccess,
  second: SharedSpaceAccess,
): SharedSpaceAccess {
  if (first.access === 'retry' || second.access === 'retry') {
    return { access: 'retry', member: false };
  }
  if (first.access === 'denied' || second.access === 'denied') {
    return { access: 'denied', member: false };
  }
  return { access: 'missing', member: false };
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
function cacheMeshengerPlaybackGrantUrl(key: string, url: string, expiresAt: number): void {
  const now = Date.now();
  for (const [cachedKey, cached] of cachedMeshengerPlaybackGrantUrls) {
    if (cached.expiresAt <= now || cachedMeshengerPlaybackGrantUrls.size >= maxCachedMediaUrls) {
      cachedMeshengerPlaybackGrantUrls.delete(cachedKey);
    }
  }
  cachedMeshengerPlaybackGrantUrls.set(key, { url, expiresAt });
}
function cacheDirectFileFallback(key: string, now: number, ttlMs = directFileFallbackTtlMs): void {
  for (const [cachedKey, expiresAt] of directFileFallbackPreferred) {
    if (expiresAt <= now || directFileFallbackPreferred.size >= maxCachedEVaultResolutions) {
      directFileFallbackPreferred.delete(cachedKey);
    }
  }
  directFileFallbackPreferred.set(key, now + ttlMs);
}
function cacheEVaultResolution(key: string, vault: ResolvedVault, now: number): void {
  for (const [cachedKey, cached] of cachedEVaultResolutions) {
    if (cached.expiresAt <= now || cachedEVaultResolutions.size >= maxCachedEVaultResolutions) {
      cachedEVaultResolutions.delete(cachedKey);
    }
  }
  cachedEVaultResolutions.set(key, { vault, expiresAt: now + eVaultResolutionTtlMs });
}
function cacheRenewedStream(key: string, renewed: RenewedStream, now: number): void {
  for (const [cachedKey, cached] of renewedStreams) {
    if (cached.expiresAt <= now || renewedStreams.size >= maxRenewedStreams)
      renewedStreams.delete(cachedKey);
  }
  renewedStreams.set(key, renewed);
}
function sharedStreamProbes(grant: StreamGrant): SharedSpaceProbe[] {
  const sourceSpaceKey = grant.sourceSpaceKey;
  if (!sourceSpaceKey) return [];
  if (grant.accessBasis === 'membership') {
    return [{ eName: sourceSpaceKey, kind: 'group' }];
  }
  if (grant.accessBasis === 'reference' && grant.sourceReferenceId && grant.sourceReferenceFileId) {
    return [
      {
        eName: sourceSpaceKey,
        kind: 'reference',
        referenceId: grant.sourceReferenceId,
        fileId: grant.sourceReferenceFileId,
      },
    ];
  }
  if (grant.accessBasis === 'history' && grant.sourceChatId) {
    return [
      {
        eName: sourceSpaceKey,
        kind: 'direct',
        chatId: grant.sourceChatId,
        ...(grant.sourceViewerChatGrantId
          ? { viewerChatGrantId: grant.sourceViewerChatGrantId }
          : {}),
      },
      { eName: sourceSpaceKey, kind: 'group' },
    ];
  }
  return [];
}

/**
 * Keep redirects and any source-issued bridge result bound to the complete
 * authorization context, rather than only the viewer and File URI. The same
 * File can legitimately be reachable through two conversations with different
 * revocation state, so their short-lived server-side entries must not bleed
 * into one another.
 */
function mediaUrlCacheKey(grant: StreamGrant): string {
  return [
    normalizeEName(grant.eName),
    grant.fileUri,
    grant.accessScope,
    grant.sourceSpaceKey ? normalizeEName(grant.sourceSpaceKey) : '',
    grant.sourceChatId ?? '',
    grant.sourceViewerChatGrantId ?? '',
    grant.sourceCallSessionVault ? normalizeEName(grant.sourceCallSessionVault) : '',
    grant.sourceCallSessionId ?? '',
    grant.sourceRecordingVault ? normalizeEName(grant.sourceRecordingVault) : '',
    grant.sourceReferenceId ?? '',
    grant.sourceReferenceFileId ?? '',
  ].join('\u0000');
}

/**
 * Only a fully-addressed canonical direct recording can skip the compatibility
 * lookup. Cards without all exact pointers retain the older verifier so an
 * inventory migration never turns a valid legacy share into a dead player.
 */
function exactSharedCallProofContext(grant: StreamGrant): ExactSharedCallProofContext | undefined {
  // Pre-version-16 direct CallSession grants did not retain a separately
  // named CallSession vault. New grants carry the exact canonical location;
  // only legacy grants fall back through their recording-vault and source
  // pointers when that location was not retained.
  const callSessionVault =
    grant.sourceCallSessionVault ?? grant.sourceRecordingVault ?? grant.sourceSpaceKey;
  if (
    grant.accessScope !== 'shared' ||
    grant.accessBasis !== 'history' ||
    grant.sourceChatKind !== 'direct' ||
    !grant.sourceSpaceKey ||
    !grant.sourceChatId ||
    !grant.sourceViewerChatGrantId ||
    !grant.sourceCallSessionId ||
    !isEName(grant.sourceSpaceKey) ||
    !callSessionVault ||
    !isEName(callSessionVault) ||
    (grant.sourceRecordingVault !== undefined && !isEName(grant.sourceRecordingVault))
  ) {
    return undefined;
  }
  return {
    source: {
      eName: callSessionVault,
      kind: 'direct',
      chatId: grant.sourceChatId,
      viewerChatGrantId: grant.sourceViewerChatGrantId,
    },
    callSessionId: grant.sourceCallSessionId,
    callSessionVault,
    chatId: grant.sourceChatId,
    viewerChatGrantId: grant.sourceViewerChatGrantId,
    fileUri: grant.fileUri,
    ...(grant.sourceRecordingVault ? { recordingVault: grant.sourceRecordingVault } : {}),
  };
}

/**
 * Keep the opaque-identity shortcut as strict as the ordinary exact proof:
 * both records must be the named direct Chat and must carry exactly two
 * string participants. Any other legacy shape remains for the compatibility
 * verifier instead of being guessed from an arbitrary identifier list.
 */
function legacyExactDirectChatParticipantIds(
  envelope: Envelope,
  context: ExactSharedCallProofContext,
): [string, string] | undefined {
  if (envelope.ontology !== chatOntology || envelope.parsed.isReference === true) return undefined;
  if (envelope.id !== context.chatId) return undefined;
  const type = optionalString(envelope.parsed.type)?.toLowerCase();
  if (type !== 'direct' || !Array.isArray(envelope.parsed.participantIds)) return undefined;
  const rawParticipants = envelope.parsed.participantIds;
  const participants = rawParticipants.filter(
    (participant): participant is string =>
      typeof participant === 'string' && Boolean(participant.trim()),
  );
  if (rawParticipants.length !== 2 || participants.length !== 2) return undefined;
  const [first, second] = participants;
  if (!first || !second) return undefined;
  return [first.trim(), second.trim()];
}

/** A User record must name the exact opaque id before it can map to an eName. */
function isExactUserParticipantEnvelope(envelope: Envelope, participantId: string): boolean {
  return (
    envelope.ontology === userOntology &&
    (envelope.id === participantId || optionalString(envelope.parsed.id) === participantId)
  );
}

/**
 * The exact eVault read is tenant-scoped to `expectedEName`, which is the
 * authoritative owner binding for a canonical User envelope. Some historical
 * writers also add an `eName` extension; when present it must agree rather
 * than being allowed to contradict the tenant binding.
 */
function userEnvelopeBindsExpectedEName(envelope: Envelope, expectedEName: string): boolean {
  const declaredEName = optionalString(envelope.parsed.eName);
  if (!declaredEName) return true;
  const normalized = asEName(declaredEName);
  return Boolean(normalized && sameEName(normalized, expectedEName));
}

/** Identity metadata is an optional positive shortcut, never a negative ACL. */
function isInconclusiveExactIdentityLookup(error: unknown): boolean {
  const failure = sourceFailureClass(error);
  return failure === 'denied' || failure === 'missing' || failure === 'rejected';
}

/**
 * An exact source Chat record is the independent source-side entitlement.
 * Older platforms may serialize direct participants as User metaIds, which
 * cannot be distinguished locally from an unrelated bare identifier. Such a
 * record is inconclusive, not a denial; the existing verifier remains the
 * authority in that case. Only a recognizable, contradictory direct record
 * denies the shortcut immediately.
 */
function sourceChatExactDirectCallValidation(
  envelope: Envelope,
  context: ExactSharedCallProofContext,
  viewerEName: string,
): ExactSharedCallProofValidation {
  if (
    envelope.ontology !== chatOntology ||
    envelope.parsed.isReference === true ||
    envelope.id !== context.chatId
  ) {
    return 'not_eligible';
  }
  return exactDirectChatParticipantsValidation(
    envelope.parsed,
    viewerEName,
    context.callSessionVault,
  );
}

/**
 * The viewer-side pointer must point to the same canonical direct Chat. A
 * reference with a complete, different canonical owner/id is a deliberate
 * contradiction. Incomplete or legacy-shaped records are merely
 * inconclusive; a canonical local Chat can still be proven if it carries the
 * exact participant pair. The source Chat is always also required above.
 */
function viewerChatGrantExactDirectCallValidation(
  envelope: Envelope,
  context: ExactSharedCallProofContext,
  viewerEName: string,
): ExactSharedCallProofValidation {
  if (envelope.ontology !== chatOntology) return 'not_eligible';
  const type = optionalString(envelope.parsed.type)?.toLowerCase();
  if (envelope.parsed.isReference === true) {
    const canonicalOwner = optionalString(envelope.parsed.canonicalOwnerEName);
    const canonicalChatId = optionalString(envelope.parsed.canonicalChatId);
    if (type === 'group') return 'denied';
    if (type !== 'direct' || !canonicalOwner || !canonicalChatId) return 'not_eligible';
    return sameEName(canonicalOwner, context.callSessionVault) && canonicalChatId === context.chatId
      ? 'verified'
      : 'denied';
  }
  if (envelope.id !== context.chatId) return 'not_eligible';
  return exactDirectChatParticipantsValidation(
    envelope.parsed,
    viewerEName,
    context.callSessionVault,
  );
}

/**
 * A bare participant id is ambiguous: it can be a bare eName or a User
 * metaId. We may use it when it equals one of the two expected identities,
 * but never use an unknown bare value as a negative membership assertion.
 * `@`-prefixed eNames are unambiguous, so a complete pair of different ones
 * is an explicit contradiction.
 */
function exactDirectChatParticipantsValidation(
  payload: RecordValue,
  viewerEName: string,
  sourceEName: string,
): ExactSharedCallProofValidation {
  const type = optionalString(payload.type)?.toLowerCase();
  if (type === 'group') return 'denied';
  if (type !== 'direct' || !Array.isArray(payload.participantIds)) return 'not_eligible';
  const rawParticipants = payload.participantIds;
  const participants = rawParticipants.filter(
    (participant): participant is string => typeof participant === 'string',
  );
  const explicitParticipants =
    participants.length > 0 &&
    participants.length === rawParticipants.length &&
    participants.every(isExplicitENameParticipant);
  const exactPair =
    participants.length === 2 &&
    rawParticipants.length === 2 &&
    participants.some((participant) => sameEName(participant, viewerEName)) &&
    participants.some((participant) => sameEName(participant, sourceEName)) &&
    participants.every(
      (participant) => sameEName(participant, viewerEName) || sameEName(participant, sourceEName),
    );
  if (exactPair) return 'verified';
  return explicitParticipants ? 'denied' : 'not_eligible';
}

function isExplicitENameParticipant(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('@') && isEName(normalized);
}

function combineExactSharedCallProofValidations(
  ...validations: ExactSharedCallProofValidation[]
): ExactSharedCallProofValidation {
  if (validations.some((validation) => validation === 'denied')) return 'denied';
  return validations.every((validation) => validation === 'verified') ? 'verified' : 'not_eligible';
}

function callSessionMatchesExactSharedFile(
  envelope: Envelope,
  context: ExactSharedCallProofContext,
  viewerEName: string,
): boolean {
  if (
    envelope.id !== context.callSessionId ||
    envelope.ontology !== callSessionOntology ||
    envelope.parsed.isReference === true ||
    optionalString(envelope.parsed.chatId) !== context.chatId ||
    !isAuthorizedCallParticipant(envelope.parsed, viewerEName)
  ) {
    return false;
  }
  const recording = record(envelope.parsed.recording);
  if (recording?.mediaIsVideo !== true) return false;
  const actualRecordingVault = optionalString(recording.recordingVault);
  if (
    context.recordingVault &&
    (!actualRecordingVault || !sameEName(actualRecordingVault, context.recordingVault))
  ) {
    return false;
  }
  return orderedRecordingFileUris(recording).includes(context.fileUri);
}

function mediaAuthorizationTimingContext(
  grant: StreamGrant,
  priority: MediaResolutionPriority,
): MediaAuthorizationTimingContext {
  const accessBasis = grant.accessBasis ?? 'personal';
  const proofKind =
    accessBasis === 'membership'
      ? 'group'
      : accessBasis === 'history'
        ? 'direct_group'
        : accessBasis === 'reference'
          ? 'reference'
          : 'personal';
  return {
    accessBasis,
    proofKind,
    sharedProofDeadlineMs:
      priority === 'interactive' && proofKind !== 'personal' ? interactiveSharedProofTimeoutMs : 0,
    viewerChatGrantHint: accessBasis === 'history' && Boolean(grant.sourceViewerChatGrantId),
  };
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
