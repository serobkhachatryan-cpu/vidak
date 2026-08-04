import { randomUUID } from 'node:crypto';
import {
  type ResourceAccessScope,
  type ResourceAuthSubject,
  type ResourceDescriptor,
  type ResourceKind,
  type ResourceOwner,
  resolveResourceRef,
} from './resource-authorization';
import {
  resolveW3dsAuthorizationOfficialClient,
  W3DS_AUTHORIZATION_SDK_GAPS,
  type W3dsAuthorizationOfficialClient,
} from './w3ds-authorization-official-client';
import { W3dsAuthorizationSyncError } from './w3ds-authorization-sync-errors';
import type {
  W3dsAuthorizationSyncRecord,
  W3dsAuthorizationSyncStore,
} from './w3ds-authorization-sync-store';

export {
  FakeW3dsAuthorizationOfficialClient,
  requireW3dsAuthorizationOfficialClient,
  resolveW3dsAuthorizationOfficialClient,
  W3DS_AUTHORIZATION_SDK_GAPS,
  type W3dsAuthorizationOfficialClient,
  type W3dsAuthorizationOfficialClientResolution,
} from './w3ds-authorization-official-client';
export type { W3dsAuthorizationSyncErrorCode } from './w3ds-authorization-sync-errors';
export { W3dsAuthorizationSyncError } from './w3ds-authorization-sync-errors';
export {
  InMemoryW3dsAuthorizationSyncStore,
  PostgresW3dsAuthorizationSyncStore,
  type W3dsAuthorizationSyncRecord,
  type W3dsAuthorizationSyncStore,
} from './w3ds-authorization-sync-store';

const eNamePattern = /^@[^\s@]+$/;

const secretPatterns: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+=/]+/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /(?:api[_-]?key|secret|password|token|authorization)\s*[:=]\s*['"]?[^'"\s,;]+/gi,
  /https?:\/\/[^/\s:@]+:[^/@\s]+@[^\s]+/gi,
  /postgresql:\/\/[^/\s:@]+:[^/@\s]+@[^\s]+/gi,
];

export interface W3dsAuthorizationSyncConfig {
  /** Same gate as Phase 1 W3DS auth configuration. */
  w3dsAuthorizationConfigured: boolean;
  /** True only when an official authorization/ACL SDK client is resolvable. */
  officialClientAvailable: boolean;
  /** Exact missing SDK/config strings when the official client is unavailable. */
  missingOfficialCapabilities: readonly string[];
}

export interface GrantResourceAccessInput {
  resource: ResourceDescriptor;
  /** Owner subject used for ensureResourceOwner (must match resource.owner). */
  owner: ResourceAuthSubject;
  /** Subject receiving the grant. */
  subject: ResourceAuthSubject;
  scope: ResourceAccessScope;
}

export interface RevokeResourceAccessInput {
  resource: ResourceDescriptor;
  owner: ResourceAuthSubject;
  subject: ResourceAuthSubject;
  scope: ResourceAccessScope;
}

export interface ReconcileResourceAccessInput {
  resource: ResourceDescriptor;
  owner: ResourceAuthSubject;
  /**
   * Intended access policy. Entries listed here are granted; any previously
   * tracked grant for the same resource that is omitted is revoked.
   * Owner binding is always ensured and is not represented as a grant entry.
   */
  intendedGrants: Array<{ subject: ResourceAuthSubject; scope: ResourceAccessScope }>;
}

export interface W3dsAuthorizationSyncServiceOptions {
  store: W3dsAuthorizationSyncStore;
  /**
   * Official-client boundary. Production resolves via
   * {@link resolveW3dsAuthorizationOfficialClient}; tests inject
   * {@link FakeW3dsAuthorizationOfficialClient}.
   */
  officialClient?: W3dsAuthorizationOfficialClient;
  /** When false, all remote mutations fail closed. Defaults to resolver result. */
  officialClientAvailable?: boolean;
  w3dsAuthorizationConfigured?: boolean;
  now?: () => number;
}

/**
 * Server-only durable W3DS authorization synchronization adapter.
 *
 * Persists grant/revoke intent, retries safely, and mutates W3DS only through
 * an injected/resolvable official client boundary. Never falls back to a local
 * grant or reports remote sync success when the SDK/config/remote call fails.
 */
export class W3dsAuthorizationSyncService {
  private readonly store: W3dsAuthorizationSyncStore;
  private readonly officialClient: W3dsAuthorizationOfficialClient | undefined;
  private readonly officialClientAvailable: boolean;
  private readonly w3dsAuthorizationConfigured: boolean;
  private readonly now: () => number;

  constructor(options: W3dsAuthorizationSyncServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.w3dsAuthorizationConfigured = options.w3dsAuthorizationConfigured ?? true;

    if (options.officialClient) {
      this.officialClient = options.officialClient;
      this.officialClientAvailable = options.officialClientAvailable ?? true;
    } else {
      const resolved = resolveW3dsAuthorizationOfficialClient();
      if (resolved.status === 'available') {
        this.officialClient = resolved.client;
        this.officialClientAvailable = true;
      } else {
        this.officialClient = undefined;
        this.officialClientAvailable = false;
      }
    }
  }

  /** Diagnostic snapshot — never includes secrets. */
  getSyncConfig(): W3dsAuthorizationSyncConfig {
    const resolved = resolveW3dsAuthorizationOfficialClient();
    return {
      w3dsAuthorizationConfigured: this.w3dsAuthorizationConfigured,
      officialClientAvailable: this.officialClientAvailable && Boolean(this.officialClient),
      missingOfficialCapabilities:
        resolved.status === 'unavailable' ? resolved.missing : ([] as const),
    };
  }

  /**
   * Idempotently ensure the resource owner binding and grant `scope` to subject.
   * Safe to retry: duplicate grants do not create additional remote grants.
   */
  async grant(input: GrantResourceAccessInput): Promise<W3dsAuthorizationSyncRecord> {
    this.assertCanMutate();
    const resource = normalizeResource(input.resource);
    const owner = normalizeSubject(input.owner, 'owner');
    const subject = normalizeSubject(input.subject, 'subject');
    assertOwnerMatches(resource.owner, owner);
    assertScopeCompatible(resource.kind, input.scope);

    const record = await this.store.upsertIntent({
      id: randomUUID(),
      resourceKind: resource.kind,
      resourceId: resource.resourceId,
      localResourceId: resource.localId,
      ownerPlatformUserId: owner.platformUserId,
      ownerEName: owner.eName,
      subjectPlatformUserId: subject.platformUserId,
      subjectEName: subject.eName,
      subjectEVaultId: subject.eVaultId,
      scope: input.scope,
      intent: 'grant',
      syncStatus: 'pending',
    });

    if (record.intent === 'grant' && record.syncStatus === 'synced') {
      return record;
    }

    return this.executeGrant(record, owner);
  }

  /**
   * Idempotently revoke `scope` from subject. Retries never restore access.
   */
  async revoke(input: RevokeResourceAccessInput): Promise<W3dsAuthorizationSyncRecord> {
    this.assertCanMutate();
    const resource = normalizeResource(input.resource);
    const owner = normalizeSubject(input.owner, 'owner');
    const subject = normalizeSubject(input.subject, 'subject');
    assertOwnerMatches(resource.owner, owner);
    assertScopeCompatible(resource.kind, input.scope);

    const record = await this.store.upsertIntent({
      id: randomUUID(),
      resourceKind: resource.kind,
      resourceId: resource.resourceId,
      localResourceId: resource.localId,
      ownerPlatformUserId: owner.platformUserId,
      ownerEName: owner.eName,
      subjectPlatformUserId: subject.platformUserId,
      subjectEName: subject.eName,
      subjectEVaultId: subject.eVaultId,
      scope: input.scope,
      intent: 'revoke',
      syncStatus: 'pending',
    });

    if (record.intent === 'revoke' && record.syncStatus === 'revoked') {
      return record;
    }

    return this.executeRevoke(record);
  }

  /**
   * Ensures owner binding, grants every intended entry, and revokes previously
   * tracked grants that are no longer intended. Partial remote failure fails
   * closed without claiming overall success.
   */
  async reconcile(input: ReconcileResourceAccessInput): Promise<W3dsAuthorizationSyncRecord[]> {
    this.assertCanMutate();
    const resource = normalizeResource(input.resource);
    const owner = normalizeSubject(input.owner, 'owner');
    assertOwnerMatches(resource.owner, owner);

    const client = this.requireClient();
    try {
      await client.ensureResourceOwner({
        resourceId: resource.resourceId,
        resourceKind: resource.kind,
        ownerEName: owner.eName,
        ownerEVaultId: owner.eVaultId,
      });
    } catch (error) {
      throw this.toSyncFailure(error, 'Failed to ensure resource owner during reconcile.');
    }

    const intendedKeys = new Set<string>();
    const results: W3dsAuthorizationSyncRecord[] = [];

    for (const entry of input.intendedGrants) {
      const subject = normalizeSubject(entry.subject, 'subject');
      assertScopeCompatible(resource.kind, entry.scope);
      intendedKeys.add(policyKey(subject.eName, entry.scope));
      results.push(
        await this.grant({
          resource,
          owner,
          subject,
          scope: entry.scope,
        }),
      );
    }

    const existing = await this.store.listByResourceId(resource.resourceId);
    for (const record of existing) {
      if (record.intent !== 'grant' && record.syncStatus !== 'synced') {
        // Still process previously granted rows that need revoke when omitted.
      }
      const key = policyKey(record.subjectEName, record.scope);
      if (intendedKeys.has(key)) continue;
      if (record.syncStatus === 'revoked' && record.intent === 'revoke') continue;
      // Only revoke rows that were (or still are) grant intents / active syncs.
      if (record.intent === 'revoke' && record.syncStatus === 'revoked') continue;
      if (
        record.intent === 'grant' ||
        record.syncStatus === 'synced' ||
        record.syncStatus === 'failed' ||
        record.syncStatus === 'pending'
      ) {
        const subject: ResourceAuthSubject = {
          platformUserId: record.subjectPlatformUserId ?? owner.platformUserId,
          eName: record.subjectEName,
          eVaultId: record.subjectEVaultId ?? owner.eVaultId,
        };
        results.push(
          await this.revoke({
            resource,
            owner,
            subject,
            scope: record.scope,
          }),
        );
      }
    }

    return results;
  }

  async getRecord(
    resourceId: string,
    subjectEName: string,
    scope: ResourceAccessScope,
  ): Promise<W3dsAuthorizationSyncRecord | undefined> {
    return this.store.getByResourceSubjectScope(resourceId, subjectEName, scope);
  }

  async listRecords(resourceId: string): Promise<W3dsAuthorizationSyncRecord[]> {
    return this.store.listByResourceId(resourceId);
  }

  private async executeGrant(
    record: W3dsAuthorizationSyncRecord,
    owner: ResourceAuthSubject,
  ): Promise<W3dsAuthorizationSyncRecord> {
    const client = this.requireClient();
    const attemptedAt = new Date(this.now()).toISOString();
    const attemptCount = record.attemptCount + 1;

    try {
      const ownerBinding = await client.ensureResourceOwner({
        resourceId: record.resourceId,
        resourceKind: record.resourceKind,
        ownerEName: owner.eName,
        ownerEVaultId: owner.eVaultId,
      });
      const granted = await client.grantAccess({
        resourceId: record.resourceId,
        resourceKind: record.resourceKind,
        subjectEName: record.subjectEName,
        scope: record.scope,
        ...(ownerBinding.externalOwnerBindingId
          ? { externalOwnerBindingId: ownerBinding.externalOwnerBindingId }
          : {}),
      });
      return await this.store.markAttempt({
        id: record.id,
        syncStatus: 'synced',
        attemptCount,
        lastAttemptedAt: attemptedAt,
        lastSyncedAt: attemptedAt,
        externalGrantId: granted.externalGrantId ?? record.externalGrantId ?? null,
        externalOwnerBindingId:
          ownerBinding.externalOwnerBindingId ?? record.externalOwnerBindingId ?? null,
        failureReason: null,
      });
    } catch (error) {
      const failureReason = redactAuthorizationFailureReason(error);
      await this.store.markAttempt({
        id: record.id,
        syncStatus: 'failed',
        attemptCount,
        lastAttemptedAt: attemptedAt,
        failureReason,
      });
      throw new W3dsAuthorizationSyncError(
        'W3DS authorization grant synchronization failed.',
        'sync_failed',
        503,
      );
    }
  }

  private async executeRevoke(
    record: W3dsAuthorizationSyncRecord,
  ): Promise<W3dsAuthorizationSyncRecord> {
    const client = this.requireClient();
    const attemptedAt = new Date(this.now()).toISOString();
    const attemptCount = record.attemptCount + 1;

    try {
      await client.revokeAccess({
        resourceId: record.resourceId,
        resourceKind: record.resourceKind,
        subjectEName: record.subjectEName,
        scope: record.scope,
        ...(record.externalGrantId ? { externalGrantId: record.externalGrantId } : {}),
      });
      return await this.store.markAttempt({
        id: record.id,
        syncStatus: 'revoked',
        attemptCount,
        lastAttemptedAt: attemptedAt,
        lastSyncedAt: attemptedAt,
        failureReason: null,
      });
    } catch (error) {
      const failureReason = redactAuthorizationFailureReason(error);
      await this.store.markAttempt({
        id: record.id,
        syncStatus: 'failed',
        attemptCount,
        lastAttemptedAt: attemptedAt,
        failureReason,
      });
      throw new W3dsAuthorizationSyncError(
        'W3DS authorization revoke synchronization failed.',
        'sync_failed',
        503,
      );
    }
  }

  private assertCanMutate(): void {
    if (!this.w3dsAuthorizationConfigured) {
      throw new W3dsAuthorizationSyncError(
        'W3DS authorization sync requires W3DS authentication configuration.',
        'configuration_error',
        503,
      );
    }
    if (!this.officialClientAvailable || !this.officialClient) {
      throw new W3dsAuthorizationSyncError(
        `W3DS authorization sync is unavailable: ${W3DS_AUTHORIZATION_SDK_GAPS.join(' ')}`,
        'sdk_unavailable',
        503,
      );
    }
  }

  private requireClient(): W3dsAuthorizationOfficialClient {
    this.assertCanMutate();
    if (!this.officialClient) {
      throw new W3dsAuthorizationSyncError(
        `W3DS authorization sync is unavailable: ${W3DS_AUTHORIZATION_SDK_GAPS.join(' ')}`,
        'sdk_unavailable',
        503,
      );
    }
    return this.officialClient;
  }

  private toSyncFailure(error: unknown, fallback: string): W3dsAuthorizationSyncError {
    if (error instanceof W3dsAuthorizationSyncError) return error;
    // Redact for logs/persistence callers; thrown message stays generic.
    void redactAuthorizationFailureReason(error, fallback);
    return new W3dsAuthorizationSyncError(fallback, 'sync_failed', 503);
  }
}

/**
 * Redacts credentials/tokens/URLs from failure text before persistence or logs.
 * Returns a short, safe summary suitable for `failure_reason`.
 */
export function redactAuthorizationFailureReason(
  error: unknown,
  fallback = 'Remote authorization mutation failed.',
): string {
  let raw = '';
  if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === 'string') {
    raw = error;
  } else if (error && typeof error === 'object') {
    try {
      raw = JSON.stringify(error);
    } catch {
      raw = fallback;
    }
  } else {
    raw = fallback;
  }

  let redacted = raw;
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  redacted = redacted.replace(/\s+/g, ' ').trim();
  if (!redacted) return fallback;
  // Cap length so persisted reasons stay operational summaries, not payloads.
  if (redacted.length > 240) {
    redacted = `${redacted.slice(0, 237)}...`;
  }
  return redacted;
}

export function readW3dsAuthorizationSyncConfig(
  env: Record<string, string | undefined> = process.env,
): W3dsAuthorizationSyncConfig {
  const registryBaseUrl = env.W3DS_REGISTRY_BASE_URL?.trim();
  const jwtSecret = env.W3DS_AUTH_JWT_SECRET;
  const databaseUrl = env.DATABASE_URL?.trim();
  const w3dsAuthorizationConfigured = Boolean(
    registryBaseUrl && jwtSecret && jwtSecret.length >= 32 && databaseUrl,
  );
  const resolved = resolveW3dsAuthorizationOfficialClient();
  return {
    w3dsAuthorizationConfigured,
    officialClientAvailable: resolved.status === 'available',
    missingOfficialCapabilities:
      resolved.status === 'unavailable' ? resolved.missing : ([] as const),
  };
}

function normalizeResource(resource: ResourceDescriptor): ResourceDescriptor {
  const ref = resolveResourceRef(resource.resourceId);
  if (!ref || ref.kind !== resource.kind || ref.localId !== resource.localId) {
    throw new W3dsAuthorizationSyncError(
      'Resource descriptor resourceId is invalid or does not match kind/local id.',
      'invalid_resource',
      400,
    );
  }
  if (!resource.owner.platformUserId.trim() || !resource.owner.eName?.trim()) {
    throw new W3dsAuthorizationSyncError(
      'Resource owner platform user id and eName are required for synchronization.',
      'invalid_resource',
      400,
    );
  }
  return resource;
}

function normalizeSubject(subject: ResourceAuthSubject, label: string): ResourceAuthSubject {
  const platformUserId = subject.platformUserId.trim();
  const eName = subject.eName.trim();
  const eVaultId = subject.eVaultId.trim();
  if (!platformUserId || !eNamePattern.test(eName) || !eVaultId) {
    throw new W3dsAuthorizationSyncError(
      `Authorization sync ${label} must be a valid W3DS identity.`,
      'invalid_subject',
      400,
    );
  }
  return { platformUserId, eName, eVaultId };
}

function assertOwnerMatches(owner: ResourceOwner, subject: ResourceAuthSubject): void {
  if (owner.platformUserId !== subject.platformUserId) {
    throw new W3dsAuthorizationSyncError(
      'Resource owner platform user id does not match the provided owner subject.',
      'invalid_subject',
      400,
    );
  }
  if (owner.eName && owner.eName !== subject.eName) {
    throw new W3dsAuthorizationSyncError(
      'Resource owner eName does not match the provided owner subject.',
      'invalid_subject',
      400,
    );
  }
}

function assertScopeCompatible(kind: ResourceKind, scope: ResourceAccessScope): void {
  const ok =
    kind === 'creator_video'
      ? scope === 'video:owner' || scope === 'video:read' || scope === 'video:discover'
      : scope === 'media:owner' || scope === 'media:read';
  if (!ok) {
    throw new W3dsAuthorizationSyncError(
      'Authorization sync scope is incompatible with the resource kind.',
      'invalid_resource',
      400,
    );
  }
}

function policyKey(subjectEName: string, scope: ResourceAccessScope): string {
  return `${subjectEName}\0${scope}`;
}
