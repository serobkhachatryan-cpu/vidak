import type { ResourceAccessScope, ResourceKind } from './resource-authorization';
import { W3dsAuthorizationSyncError } from './w3ds-authorization-sync-errors';

/**
 * Narrow boundary over officially supported W3DS authorization / ACL / eVault
 * methods. Implementations may only wrap installed SDK surfaces — never invent
 * raw HTTP endpoints or undocumented request formats.
 */
export interface W3dsAuthorizationOfficialClient {
  /** Package / export path that provided the methods (for diagnostics). */
  readonly source: string;
  /**
   * Idempotently bind the resource owner in W3DS using the stable opaque
   * Phase 1 `resourceId`.
   */
  ensureResourceOwner(input: {
    resourceId: string;
    resourceKind: ResourceKind;
    ownerEName: string;
    ownerEVaultId: string;
  }): Promise<{ externalOwnerBindingId?: string }>;
  /** Idempotently grant `scope` to `subjectEName` on the resource. */
  grantAccess(input: {
    resourceId: string;
    resourceKind: ResourceKind;
    subjectEName: string;
    scope: ResourceAccessScope;
    externalOwnerBindingId?: string;
  }): Promise<{ externalGrantId?: string }>;
  /**
   * Idempotently revoke `scope` from `subjectEName`. Must not restore access
   * when retried after a successful revoke.
   */
  revokeAccess(input: {
    resourceId: string;
    resourceKind: ResourceKind;
    subjectEName: string;
    scope: ResourceAccessScope;
    externalGrantId?: string;
  }): Promise<void>;
  /**
   * Optional read-back used by reconcile. When omitted, reconcile applies local
   * intent only through grant/revoke mutations.
   */
  listAccessGrants?(input: { resourceId: string; resourceKind: ResourceKind }): Promise<
    Array<{
      subjectEName: string;
      scope: ResourceAccessScope;
      externalGrantId?: string;
    }>
  >;
}

export type W3dsAuthorizationOfficialClientResolution =
  | { status: 'available'; client: W3dsAuthorizationOfficialClient }
  | { status: 'unavailable'; missing: readonly string[] };

/**
 * Exact gaps that block live W3DS authorization mutation in this repository.
 * Kept as stable strings for docs, config diagnostics, and fail-closed errors.
 */
export const W3DS_AUTHORIZATION_SDK_GAPS = [
  'Official W3DS authorization/ACL/eVault SDK methods are not installed. The workspace package @w3ds/sdk currently exports an empty module and exposes no ensureResourceOwner, grantAccess, revokeAccess, or equivalent ACL API.',
  'No installed dependency documents a supported authorization-mutation client for this app to wrap. Fabricating GraphQL/HTTP ACL calls is not permitted.',
  'Remote authorization mutation configuration beyond existing W3DS auth gates (W3DS_REGISTRY_BASE_URL, W3DS_AUTH_JWT_SECRET, DATABASE_URL) is therefore undefined until an official SDK surface and its required credentials are added.',
] as const;

/**
 * Resolves an officially supported authorization client from installed packages.
 *
 * This repository does not currently ship any supported W3DS authorization/ACL
 * SDK methods (`@w3ds/sdk` is an empty export). The resolver therefore returns
 * unavailable and must not invent raw eVault/Registry HTTP integrations.
 */
export function resolveW3dsAuthorizationOfficialClient(): W3dsAuthorizationOfficialClientResolution {
  return { status: 'unavailable', missing: W3DS_AUTHORIZATION_SDK_GAPS };
}

/** Throws sdk_unavailable with the exact missing capability list. */
export function requireW3dsAuthorizationOfficialClient(): W3dsAuthorizationOfficialClient {
  const resolved = resolveW3dsAuthorizationOfficialClient();
  if (resolved.status === 'available') {
    return resolved.client;
  }
  throw new W3dsAuthorizationSyncError(
    `W3DS authorization sync is unavailable: ${resolved.missing.join(' ')}`,
    'sdk_unavailable',
    503,
  );
}

/**
 * In-memory fake of the official-client boundary for provider/service tests.
 * Not a production fallback and never selected by resolveW3dsAuthorizationOfficialClient.
 */
export class FakeW3dsAuthorizationOfficialClient implements W3dsAuthorizationOfficialClient {
  readonly source = 'fake://w3ds-authorization-official-client';

  private ownerBindings = new Map<string, string>();
  private grants = new Map<string, { externalGrantId: string; revoked: boolean }>();
  private grantSeq = 0;
  private ownerSeq = 0;
  /** When set, the next matching operation fails once (then clears). */
  private nextFailure: { method: string; message: string } | undefined;
  readonly calls: Array<{ method: string; input: unknown }> = [];

  failNext(
    method: 'ensureResourceOwner' | 'grantAccess' | 'revokeAccess' | 'listAccessGrants',
    message: string,
  ): void {
    this.nextFailure = { method, message };
  }

  async ensureResourceOwner(input: {
    resourceId: string;
    resourceKind: ResourceKind;
    ownerEName: string;
    ownerEVaultId: string;
  }): Promise<{ externalOwnerBindingId?: string }> {
    this.record('ensureResourceOwner', input);
    this.throwIfFailed('ensureResourceOwner');
    const key = input.resourceId;
    const existing = this.ownerBindings.get(key);
    if (existing) {
      return { externalOwnerBindingId: existing };
    }
    this.ownerSeq += 1;
    const externalOwnerBindingId = `owner-binding-${this.ownerSeq}`;
    this.ownerBindings.set(key, externalOwnerBindingId);
    return { externalOwnerBindingId };
  }

  async grantAccess(input: {
    resourceId: string;
    resourceKind: ResourceKind;
    subjectEName: string;
    scope: ResourceAccessScope;
    externalOwnerBindingId?: string;
  }): Promise<{ externalGrantId?: string }> {
    this.record('grantAccess', input);
    this.throwIfFailed('grantAccess');
    const key = grantKey(input.resourceId, input.subjectEName, input.scope);
    const existing = this.grants.get(key);
    if (existing && !existing.revoked) {
      return { externalGrantId: existing.externalGrantId };
    }
    this.grantSeq += 1;
    const externalGrantId = `grant-${this.grantSeq}`;
    this.grants.set(key, { externalGrantId, revoked: false });
    return { externalGrantId };
  }

  async revokeAccess(input: {
    resourceId: string;
    resourceKind: ResourceKind;
    subjectEName: string;
    scope: ResourceAccessScope;
    externalGrantId?: string;
  }): Promise<void> {
    this.record('revokeAccess', input);
    this.throwIfFailed('revokeAccess');
    const key = grantKey(input.resourceId, input.subjectEName, input.scope);
    const existing = this.grants.get(key);
    if (!existing) {
      this.grants.set(key, {
        externalGrantId: input.externalGrantId ?? `grant-revoked-${key}`,
        revoked: true,
      });
      return;
    }
    this.grants.set(key, { ...existing, revoked: true });
  }

  async listAccessGrants(input: { resourceId: string; resourceKind: ResourceKind }): Promise<
    Array<{
      subjectEName: string;
      scope: ResourceAccessScope;
      externalGrantId?: string;
    }>
  > {
    this.record('listAccessGrants', input);
    this.throwIfFailed('listAccessGrants');
    const result: Array<{
      subjectEName: string;
      scope: ResourceAccessScope;
      externalGrantId?: string;
    }> = [];
    for (const [key, value] of this.grants) {
      if (!key.startsWith(`${input.resourceId}\0`) || value.revoked) continue;
      const [, subjectEName, scope] = key.split('\0');
      if (!subjectEName || !scope) continue;
      result.push({
        subjectEName,
        scope: scope as ResourceAccessScope,
        externalGrantId: value.externalGrantId,
      });
    }
    return result;
  }

  /** Test helper: whether a non-revoked grant exists remotely. */
  hasActiveGrant(resourceId: string, subjectEName: string, scope: ResourceAccessScope): boolean {
    const existing = this.grants.get(grantKey(resourceId, subjectEName, scope));
    return Boolean(existing && !existing.revoked);
  }

  private record(method: string, input: unknown): void {
    this.calls.push({ method, input });
  }

  private throwIfFailed(method: string): void {
    if (this.nextFailure?.method === method) {
      const message = this.nextFailure.message;
      this.nextFailure = undefined;
      throw new Error(message);
    }
  }
}

function grantKey(resourceId: string, subjectEName: string, scope: ResourceAccessScope): string {
  return `${resourceId}\0${subjectEName}\0${scope}`;
}
