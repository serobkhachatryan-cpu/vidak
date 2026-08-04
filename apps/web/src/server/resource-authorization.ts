import { createHash } from 'node:crypto';
import { type AuthProviderId, type AuthUser, resolveAuthProviderId } from '@w3ds/auth';
import type { VideoStatus, VideoVisibility } from '@w3ds/types';
import { ResourceAuthorizationError } from './resource-authorization-errors';
import { isW3dsAuthConfigured } from './server-config';
import { resolveW3dsAuthorizationOfficialClient } from './w3ds-authorization-official-client';

export type { ResourceAuthorizationErrorCode } from './resource-authorization-errors';
export { ResourceAuthorizationError } from './resource-authorization-errors';

/**
 * Provider-neutral resource kinds covered by this authorization foundation.
 * Channel / collection kinds are intentionally deferred.
 */
export type ResourceKind = 'creator_video' | 'media_asset';

/**
 * Access scopes for creator videos and media.
 * Product vocabulary — not eVault ACL arrays.
 */
export type ResourceAccessScope =
  | 'video:owner'
  | 'video:read'
  | 'video:discover'
  | 'media:owner'
  | 'media:read';

/**
 * Canonical authorization subject from a verified W3DS platform identity.
 *
 * Uses platform user id + eName + eVault id only. Email and browser-controlled
 * identifiers are never authorization subjects.
 */
export interface ResourceAuthSubject {
  /** Local platform primary key (`w3ds_platform_users.id` / JWT `sub`). */
  platformUserId: string;
  /** Global W3ID / eName (`@…`). */
  eName: string;
  /** eVault instance identifier. */
  eVaultId: string;
}

/** Resource owner bound to a platform identity (and optionally eName for later sync). */
export interface ResourceOwner {
  platformUserId: string;
  eName?: string;
}

/**
 * Stable, opaque resource reference suitable for later W3DS ownership/grant sync.
 * `resourceId` is server-decodable; it must not be treated as a browser secret.
 */
export interface ResourceRef {
  kind: ResourceKind;
  /** Opaque, deterministic resource identifier. */
  resourceId: string;
  /** Local platform primary key for the resource row. */
  localId: string;
}

/**
 * Authorization input describing a video or media resource.
 * Visibility/status mirror the product model used by draft/publish/public routes.
 */
export interface ResourceDescriptor {
  kind: ResourceKind;
  localId: string;
  resourceId: string;
  owner: ResourceOwner;
  /**
   * Product visibility. Required for video resources; for media assets this is
   * the parent video's visibility when evaluating anonymous `media:read`.
   */
  visibility: VideoVisibility;
  /**
   * Product lifecycle status. Required for video resources; for media assets
   * this is the parent video's status when evaluating anonymous `media:read`.
   */
  status: VideoStatus;
  /** Parent video local id when `kind === 'media_asset'`. */
  parentVideoLocalId?: string;
  /** Opaque public video id when assigned (informational; not used for ownership). */
  publicVideoId?: string;
}

export type ResourceAuthPrincipal =
  | { kind: 'authenticated'; subject: ResourceAuthSubject }
  | { kind: 'anonymous' };

export interface ResourceAuthorizationRequest {
  principal: ResourceAuthPrincipal;
  resource: ResourceDescriptor;
  scope: ResourceAccessScope;
}

export type ResourceAuthorizationDecisionReason =
  | 'owner'
  | 'published_public'
  | 'published_unlisted'
  | 'anonymous_denied'
  | 'not_owner'
  | 'private_visibility'
  | 'unlisted_not_discoverable'
  | 'not_published'
  | 'scope_mismatch'
  | 'invalid_subject'
  | 'capability_unavailable';

export interface ResourceAuthorizationDecision {
  allowed: boolean;
  reason: ResourceAuthorizationDecisionReason;
}

/**
 * Explicit capability matrix for the active authorization provider.
 * Remote mutation/sync stay false unless an official W3DS authorization SDK
 * client is installed and W3DS auth configuration is present.
 */
export interface ResourceAuthorizationCapabilities {
  /** Evaluate local ownership + visibility policy (Phase 1). */
  localPolicyEvaluation: boolean;
  /** Evaluate remote eVault ACL / grants. No official evaluate API is installed. */
  remoteGrantEvaluation: boolean;
  /** Mutate remote ACLs / grants via an official SDK client boundary. */
  remoteGrantMutation: boolean;
  /** Durable ownership/grant synchronization with W3DS. */
  grantSynchronization: boolean;
}

export type ResourceAuthorizationProviderId = 'local' | 'w3ds';

/**
 * Server-only authorization provider boundary.
 * Implementations must not accept browser-controlled subjects or email.
 */
export interface ResourceAuthorizationProvider {
  readonly id: ResourceAuthorizationProviderId;
  capabilities(): ResourceAuthorizationCapabilities;
  /**
   * Evaluate whether `request.principal` may exercise `request.scope` on the resource.
   * Does not perform W3DS/eVault network I/O in this phase.
   */
  authorize(request: ResourceAuthorizationRequest): Promise<ResourceAuthorizationDecision>;
  /**
   * Assert that a capability is available. Fail-closed when unavailable.
   */
  requireCapability(capability: keyof ResourceAuthorizationCapabilities): void;
}

export interface ResourceAuthorizationConfig {
  /**
   * Active authorization provider selection.
   * Derived from `AUTH_PROVIDER` unless overridden in tests.
   */
  provider: ResourceAuthorizationProviderId;
  /**
   * Whether W3DS authorization configuration is present (auth secrets + registry).
   * Required to construct the W3DS authorization provider; never invents remote capabilities.
   */
  w3dsAuthorizationConfigured: boolean;
  /**
   * Whether an officially supported W3DS authorization/ACL SDK client is present.
   * Required for remoteGrantMutation / grantSynchronization; currently false.
   */
  w3dsOfficialAuthorizationClientAvailable: boolean;
  /** Exact missing SDK/configuration strings when the official client is absent. */
  w3dsAuthorizationMissingCapabilities: readonly string[];
}

const resourceKindCodes = {
  creator_video: 'v',
  media_asset: 'm',
} as const satisfies Record<ResourceKind, string>;

const resourceKindFromCode: Record<string, ResourceKind> = {
  v: 'creator_video',
  m: 'media_asset',
};

const eNamePattern = /^@[^\s@]+$/;

const localCapabilities = {
  localPolicyEvaluation: true,
  remoteGrantEvaluation: false,
  remoteGrantMutation: false,
  grantSynchronization: false,
} as const satisfies ResourceAuthorizationCapabilities;

const w3dsLocalOnlyCapabilities = {
  localPolicyEvaluation: true,
  remoteGrantEvaluation: false,
  remoteGrantMutation: false,
  grantSynchronization: false,
} as const satisfies ResourceAuthorizationCapabilities;

/**
 * Builds a canonical subject from an authenticated platform user.
 * Rejects missing/unsafe identities; never falls back to email.
 */
export function toResourceAuthSubject(user: AuthUser): ResourceAuthSubject {
  if (!user || typeof user !== 'object') {
    throw new ResourceAuthorizationError(
      'Authenticated W3DS identity is required for authorization.',
      'invalid_subject',
      401,
    );
  }
  const platformUserId = typeof user.id === 'string' ? user.id.trim() : '';
  const eName = typeof user.eName === 'string' ? user.eName.trim() : '';
  const eVaultId = typeof user.eVaultId === 'string' ? user.eVaultId.trim() : '';

  if (!platformUserId) {
    throw new ResourceAuthorizationError(
      'Authenticated W3DS identity is missing a platform user id.',
      'invalid_subject',
      401,
    );
  }
  if (!eName || !eNamePattern.test(eName)) {
    throw new ResourceAuthorizationError(
      'Authenticated W3DS identity is missing a valid eName.',
      'invalid_subject',
      401,
    );
  }
  if (!eVaultId) {
    throw new ResourceAuthorizationError(
      'Authenticated W3DS identity is missing an eVault id.',
      'invalid_subject',
      401,
    );
  }

  return { platformUserId, eName, eVaultId };
}

/** Anonymous principal helper. */
export function anonymousPrincipal(): ResourceAuthPrincipal {
  return { kind: 'anonymous' };
}

/** Authenticated principal from a verified platform user. */
export function authenticatedPrincipal(user: AuthUser): ResourceAuthPrincipal {
  return { kind: 'authenticated', subject: toResourceAuthSubject(user) };
}

/**
 * Creates a stable, opaque resource reference for a local platform resource.
 * Encoding is deterministic and server-decodable; no database row is required in Phase 1.
 */
export function createResourceRef(kind: ResourceKind, localId: string): ResourceRef {
  const normalizedLocalId = localId.trim();
  if (!normalizedLocalId) {
    throw new ResourceAuthorizationError('Resource local id is required.', 'invalid_subject', 400);
  }
  const digest = createHash('sha256')
    .update(`vidak:resource:${kind}:${normalizedLocalId}`)
    .digest('base64url')
    .slice(0, 32);
  const encodedLocalId = Buffer.from(normalizedLocalId, 'utf8').toString('base64url');
  return {
    kind,
    localId: normalizedLocalId,
    resourceId: `vra_1_${resourceKindCodes[kind]}_${digest}_${encodedLocalId}`,
  };
}

/**
 * Resolves a previously issued opaque `resourceId` back to kind + local id.
 * Returns undefined for malformed or unrecognized identifiers.
 */
export function resolveResourceRef(resourceId: string): ResourceRef | undefined {
  const normalized = resourceId.trim();
  const match = /^vra_1_([vm])_([A-Za-z0-9_-]{32})_(.+)$/.exec(normalized);
  if (!match) return undefined;
  const kind = resourceKindFromCode[match[1] ?? ''];
  const digest = match[2];
  const encodedLocalId = match[3];
  if (!kind || !digest || !encodedLocalId) return undefined;
  let localId: string;
  try {
    localId = Buffer.from(encodedLocalId, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (!localId) return undefined;
  const expected = createResourceRef(kind, localId);
  if (expected.resourceId !== normalized) return undefined;
  return expected;
}

/** Builds a video resource descriptor with a stable opaque resource id. */
export function createVideoResourceDescriptor(input: {
  localId: string;
  owner: ResourceOwner;
  visibility: VideoVisibility;
  status: VideoStatus;
  publicVideoId?: string;
}): ResourceDescriptor {
  const ref = createResourceRef('creator_video', input.localId);
  return {
    kind: 'creator_video',
    localId: ref.localId,
    resourceId: ref.resourceId,
    owner: normalizeOwner(input.owner),
    visibility: input.visibility,
    status: input.status,
    ...(input.publicVideoId?.trim() ? { publicVideoId: input.publicVideoId.trim() } : {}),
  };
}

/** Builds a media resource descriptor; visibility/status are the parent video's. */
export function createMediaResourceDescriptor(input: {
  localId: string;
  parentVideoLocalId: string;
  owner: ResourceOwner;
  visibility: VideoVisibility;
  status: VideoStatus;
  publicVideoId?: string;
}): ResourceDescriptor {
  const ref = createResourceRef('media_asset', input.localId);
  const parentVideoLocalId = input.parentVideoLocalId.trim();
  if (!parentVideoLocalId) {
    throw new ResourceAuthorizationError(
      'Media resource requires a parent video local id.',
      'invalid_subject',
      400,
    );
  }
  return {
    kind: 'media_asset',
    localId: ref.localId,
    resourceId: ref.resourceId,
    owner: normalizeOwner(input.owner),
    visibility: input.visibility,
    status: input.status,
    parentVideoLocalId,
    ...(input.publicVideoId?.trim() ? { publicVideoId: input.publicVideoId.trim() } : {}),
  };
}

/**
 * Pure local policy evaluation matching current ownership and visibility behavior:
 *
 * - Owner scopes require an authenticated subject whose `platformUserId` matches the owner.
 * - Anonymous `video:read` / `media:read` allow published `public` or `unlisted` only.
 * - Anonymous `video:discover` allows published `public` only.
 * - Drafts and `private` published videos are never anonymously readable/discoverable.
 *
 * This phase evaluates policy only — routes retain their existing enforcement paths.
 */
export function evaluateLocalResourcePolicy(
  request: ResourceAuthorizationRequest,
): ResourceAuthorizationDecision {
  const { principal, resource, scope } = request;

  if (!isScopeCompatibleWithKind(scope, resource.kind)) {
    return { allowed: false, reason: 'scope_mismatch' };
  }

  if (scope === 'video:owner' || scope === 'media:owner') {
    if (principal.kind !== 'authenticated') {
      return { allowed: false, reason: 'anonymous_denied' };
    }
    if (!isValidSubject(principal.subject)) {
      return { allowed: false, reason: 'invalid_subject' };
    }
    if (principal.subject.platformUserId !== resource.owner.platformUserId) {
      return { allowed: false, reason: 'not_owner' };
    }
    return { allowed: true, reason: 'owner' };
  }

  if (scope === 'video:discover') {
    if (resource.kind !== 'creator_video') {
      return { allowed: false, reason: 'scope_mismatch' };
    }
    if (resource.status !== 'published') {
      return { allowed: false, reason: 'not_published' };
    }
    if (resource.visibility === 'private') {
      return { allowed: false, reason: 'private_visibility' };
    }
    if (resource.visibility === 'unlisted') {
      return { allowed: false, reason: 'unlisted_not_discoverable' };
    }
    return { allowed: true, reason: 'published_public' };
  }

  // video:read / media:read
  if (principal.kind === 'authenticated') {
    if (!isValidSubject(principal.subject)) {
      return { allowed: false, reason: 'invalid_subject' };
    }
    if (principal.subject.platformUserId === resource.owner.platformUserId) {
      return { allowed: true, reason: 'owner' };
    }
  }

  if (resource.status !== 'published') {
    return { allowed: false, reason: 'not_published' };
  }
  if (resource.visibility === 'public') {
    return { allowed: true, reason: 'published_public' };
  }
  if (resource.visibility === 'unlisted') {
    return { allowed: true, reason: 'published_unlisted' };
  }
  return { allowed: false, reason: 'private_visibility' };
}

/**
 * Development / local authorization provider.
 * Explicitly exposes only local policy capabilities — never silent W3DS remote grants.
 */
export class LocalResourceAuthorizationProvider implements ResourceAuthorizationProvider {
  readonly id = 'local' as const;

  capabilities(): ResourceAuthorizationCapabilities {
    return { ...localCapabilities };
  }

  requireCapability(capability: keyof ResourceAuthorizationCapabilities): void {
    if (!this.capabilities()[capability]) {
      throw new ResourceAuthorizationError(
        `Authorization capability "${capability}" is unavailable for the local provider.`,
        'capability_unavailable',
        503,
      );
    }
  }

  async authorize(request: ResourceAuthorizationRequest): Promise<ResourceAuthorizationDecision> {
    this.requireCapability('localPolicyEvaluation');
    return evaluateLocalResourcePolicy(normalizeRequest(request));
  }
}

/**
 * W3DS-oriented authorization provider boundary.
 *
 * Local ownership/visibility policy remains the authorize() path. Remote grant
 * mutation/sync capabilities are enabled only when an official W3DS
 * authorization/ACL SDK client is installed and auth configuration is present.
 * Missing SDK/config fails closed — never silent local-grant fallback.
 */
export class W3dsResourceAuthorizationProvider implements ResourceAuthorizationProvider {
  readonly id = 'w3ds' as const;
  private readonly remoteSyncAvailable: boolean;
  private readonly missingCapabilities: readonly string[];

  constructor(options: {
    configured: boolean;
    officialClientAvailable?: boolean;
    missingCapabilities?: readonly string[];
  }) {
    if (!options.configured) {
      throw new ResourceAuthorizationError(
        'W3DS resource authorization is not configured.',
        'configuration_error',
        503,
      );
    }
    this.remoteSyncAvailable = Boolean(options.officialClientAvailable);
    this.missingCapabilities = options.missingCapabilities ?? [];
  }

  capabilities(): ResourceAuthorizationCapabilities {
    if (!this.remoteSyncAvailable) {
      return { ...w3dsLocalOnlyCapabilities };
    }
    return {
      localPolicyEvaluation: true,
      // No official remote evaluate API is installed yet.
      remoteGrantEvaluation: false,
      remoteGrantMutation: true,
      grantSynchronization: true,
    };
  }

  requireCapability(capability: keyof ResourceAuthorizationCapabilities): void {
    if (!this.capabilities()[capability]) {
      const missing =
        this.missingCapabilities.length > 0
          ? ` Missing: ${this.missingCapabilities.join(' ')}`
          : '';
      throw new ResourceAuthorizationError(
        `Authorization capability "${capability}" is unavailable for the W3DS provider.${missing}`,
        'capability_unavailable',
        503,
      );
    }
  }

  async authorize(request: ResourceAuthorizationRequest): Promise<ResourceAuthorizationDecision> {
    this.requireCapability('localPolicyEvaluation');
    // authorize() stays local-policy-only; remote sync is a separate adapter.
    return evaluateLocalResourcePolicy(normalizeRequest(request));
  }
}

/**
 * Reads server-only authorization configuration.
 * Never reads browser-controlled identifiers or exposes secrets.
 */
export function readResourceAuthorizationConfig(
  env: Record<string, string | undefined> = process.env,
): ResourceAuthorizationConfig {
  const authProvider = resolveAuthProviderId(env.AUTH_PROVIDER ?? env.NEXT_PUBLIC_AUTH_PROVIDER);
  const w3dsAuthorizationConfigured = isW3dsAuthorizationConfigured(env);
  const provider = resolveAuthorizationProviderId(authProvider, env.W3DS_AUTHZ_PROVIDER);
  const official = resolveW3dsAuthorizationOfficialClient();
  return {
    provider,
    w3dsAuthorizationConfigured,
    w3dsOfficialAuthorizationClientAvailable: official.status === 'available',
    w3dsAuthorizationMissingCapabilities:
      official.status === 'unavailable' ? official.missing : ([] as const),
  };
}

/**
 * Creates the configured authorization provider.
 * Development stays on the explicit local provider; W3DS fails closed when unconfigured.
 * Remote sync capabilities stay disabled without an official authorization SDK client.
 */
export function createResourceAuthorizationProvider(
  config: ResourceAuthorizationConfig = readResourceAuthorizationConfig(),
): ResourceAuthorizationProvider {
  if (config.provider === 'local') {
    return new LocalResourceAuthorizationProvider();
  }
  if (!config.w3dsAuthorizationConfigured) {
    throw new ResourceAuthorizationError(
      'W3DS resource authorization requires W3DS authentication configuration.',
      'configuration_error',
      503,
    );
  }
  return new W3dsResourceAuthorizationProvider({
    configured: true,
    officialClientAvailable: config.w3dsOfficialAuthorizationClientAvailable,
    missingCapabilities: config.w3dsAuthorizationMissingCapabilities,
  });
}

let sharedProvider: ResourceAuthorizationProvider | undefined;

/** Process singleton for later route wiring. Not used by routes in this phase. */
export function getResourceAuthorizationProvider(): ResourceAuthorizationProvider {
  sharedProvider ??= createResourceAuthorizationProvider();
  return sharedProvider;
}

/** Test helper to clear the process singleton between cases. */
export function resetResourceAuthorizationProviderForTests(): void {
  sharedProvider = undefined;
}

function resolveAuthorizationProviderId(
  authProvider: AuthProviderId,
  override: string | undefined,
): ResourceAuthorizationProviderId {
  const normalized = override?.trim().toLocaleLowerCase();
  if (normalized === 'local') return 'local';
  if (normalized === 'w3ds') return 'w3ds';
  if (normalized) {
    throw new ResourceAuthorizationError(
      `Unsupported W3DS_AUTHZ_PROVIDER "${override}". Expected "local" or "w3ds".`,
      'configuration_error',
      503,
    );
  }
  // Keep development behavior explicit: AUTH_PROVIDER=dev → local authz only.
  return authProvider === 'w3ds' ? 'w3ds' : 'local';
}

function isW3dsAuthorizationConfigured(env: Record<string, string | undefined>): boolean {
  // Shared gate with auth/server-config — registry, JWT secret, and DATABASE_URL.
  return isW3dsAuthConfigured(env);
}

function normalizeOwner(owner: ResourceOwner): ResourceOwner {
  const platformUserId = owner.platformUserId.trim();
  if (!platformUserId) {
    throw new ResourceAuthorizationError(
      'Resource owner platform user id is required.',
      'invalid_subject',
      400,
    );
  }
  const eName = owner.eName?.trim();
  if (eName !== undefined && eName !== '' && !eNamePattern.test(eName)) {
    throw new ResourceAuthorizationError(
      'Resource owner eName is invalid.',
      'invalid_subject',
      400,
    );
  }
  return {
    platformUserId,
    ...(eName ? { eName } : {}),
  };
}

function normalizeRequest(request: ResourceAuthorizationRequest): ResourceAuthorizationRequest {
  if (request.principal.kind === 'authenticated' && !isValidSubject(request.principal.subject)) {
    throw new ResourceAuthorizationError(
      'Authenticated W3DS identity is invalid for authorization.',
      'invalid_subject',
      401,
    );
  }
  return request;
}

function isValidSubject(subject: ResourceAuthSubject): boolean {
  return Boolean(
    subject.platformUserId.trim() &&
      eNamePattern.test(subject.eName.trim()) &&
      subject.eVaultId.trim(),
  );
}

function isScopeCompatibleWithKind(scope: ResourceAccessScope, kind: ResourceKind): boolean {
  if (kind === 'creator_video') {
    return scope === 'video:owner' || scope === 'video:read' || scope === 'video:discover';
  }
  return scope === 'media:owner' || scope === 'media:read';
}
