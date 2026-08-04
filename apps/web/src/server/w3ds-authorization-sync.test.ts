import { createAuthUser } from '@w3ds/auth';
import { describe, expect, it } from 'vitest';
import {
  createResourceAuthorizationProvider,
  createVideoResourceDescriptor,
  readResourceAuthorizationConfig,
  toResourceAuthSubject,
  W3dsResourceAuthorizationProvider,
} from './resource-authorization';
import {
  FakeW3dsAuthorizationOfficialClient,
  InMemoryW3dsAuthorizationSyncStore,
  readW3dsAuthorizationSyncConfig,
  redactAuthorizationFailureReason,
  resolveW3dsAuthorizationOfficialClient,
  W3DS_AUTHORIZATION_SDK_GAPS,
  W3dsAuthorizationSyncError,
  W3dsAuthorizationSyncService,
} from './w3ds-authorization-sync';

const ownerUser = createAuthUser({
  id: 'user-owner',
  displayName: 'Owner',
  roles: ['creator'],
  eName: '@owner.w3id',
  eVaultId: 'evault-owner',
});

const granteeUser = createAuthUser({
  id: 'user-grantee',
  displayName: 'Grantee',
  roles: ['creator'],
  eName: '@grantee.w3id',
  eVaultId: 'evault-grantee',
});

const owner = toResourceAuthSubject(ownerUser);
const grantee = toResourceAuthSubject(granteeUser);

function videoResource() {
  return createVideoResourceDescriptor({
    localId: 'video-sync-1',
    owner: { platformUserId: owner.platformUserId, eName: owner.eName },
    visibility: 'private',
    status: 'draft',
  });
}

function createService(client?: FakeW3dsAuthorizationOfficialClient) {
  const officialClient = client ?? new FakeW3dsAuthorizationOfficialClient();
  const store = new InMemoryW3dsAuthorizationSyncStore();
  const service = new W3dsAuthorizationSyncService({
    store,
    officialClient,
    w3dsAuthorizationConfigured: true,
  });
  return { service, store, officialClient };
}

describe('official W3DS authorization client resolution', () => {
  it('reports the exact missing SDK capability and stays unavailable', () => {
    const resolved = resolveW3dsAuthorizationOfficialClient();
    expect(resolved.status).toBe('unavailable');
    if (resolved.status !== 'unavailable') return;
    expect(resolved.missing).toEqual([...W3DS_AUTHORIZATION_SDK_GAPS]);
    expect(resolved.missing.join(' ')).toContain('@w3ds/sdk');
    expect(resolved.missing.join(' ')).toContain('ensureResourceOwner');
  });

  it('keeps sync config fail-closed without inventing remote credentials', () => {
    const config = readW3dsAuthorizationSyncConfig({
      AUTH_PROVIDER: 'w3ds',
      W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
      W3DS_AUTH_JWT_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgresql://vidak:vidak@127.0.0.1:5432/vidak',
    });
    expect(config.w3dsAuthorizationConfigured).toBe(true);
    expect(config.officialClientAvailable).toBe(false);
    expect(config.missingOfficialCapabilities).toEqual([...W3DS_AUTHORIZATION_SDK_GAPS]);
  });

  it('fails closed when configuration is missing', () => {
    const config = readW3dsAuthorizationSyncConfig({});
    expect(config.w3dsAuthorizationConfigured).toBe(false);
    expect(config.officialClientAvailable).toBe(false);
  });
});

describe('W3dsAuthorizationSyncService with fake official client', () => {
  it('grants idempotently without duplicating remote grants', async () => {
    const { service, officialClient } = createService();
    const resource = videoResource();

    const first = await service.grant({
      resource,
      owner,
      subject: grantee,
      scope: 'video:read',
    });
    const second = await service.grant({
      resource,
      owner,
      subject: grantee,
      scope: 'video:read',
    });

    expect(first.syncStatus).toBe('synced');
    expect(second.syncStatus).toBe('synced');
    expect(second.externalGrantId).toBe(first.externalGrantId);
    expect(officialClient.hasActiveGrant(resource.resourceId, grantee.eName, 'video:read')).toBe(
      true,
    );
    expect(officialClient.calls.filter((call) => call.method === 'grantAccess')).toHaveLength(1);
    expect(
      officialClient.calls.filter((call) => call.method === 'ensureResourceOwner').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('retries a failed grant and persists a redacted failure reason', async () => {
    const { service, officialClient, store } = createService();
    const resource = videoResource();
    officialClient.failNext(
      'grantAccess',
      'Remote denied Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb secret=super-secret-value',
    );

    await expect(
      service.grant({
        resource,
        owner,
        subject: grantee,
        scope: 'video:read',
      }),
    ).rejects.toMatchObject({ code: 'sync_failed', status: 503 });

    const failed = await store.getByResourceSubjectScope(
      resource.resourceId,
      grantee.eName,
      'video:read',
    );
    expect(failed?.syncStatus).toBe('failed');
    expect(failed?.attemptCount).toBe(1);
    expect(failed?.failureReason).toBeTruthy();
    expect(failed?.failureReason).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(failed?.failureReason).not.toContain('super-secret-value');
    expect(failed?.failureReason).toContain('[REDACTED]');

    const retried = await service.grant({
      resource,
      owner,
      subject: grantee,
      scope: 'video:read',
    });
    expect(retried.syncStatus).toBe('synced');
    expect(retried.attemptCount).toBe(2);
    expect(retried.failureReason).toBeUndefined();
  });

  it('revokes idempotently and does not restore access on retry', async () => {
    const { service, officialClient } = createService();
    const resource = videoResource();

    await service.grant({
      resource,
      owner,
      subject: grantee,
      scope: 'video:read',
    });
    const revoked = await service.revoke({
      resource,
      owner,
      subject: grantee,
      scope: 'video:read',
    });
    const revokedAgain = await service.revoke({
      resource,
      owner,
      subject: grantee,
      scope: 'video:read',
    });

    expect(revoked.syncStatus).toBe('revoked');
    expect(revoked.intent).toBe('revoke');
    expect(revokedAgain.syncStatus).toBe('revoked');
    expect(officialClient.hasActiveGrant(resource.resourceId, grantee.eName, 'video:read')).toBe(
      false,
    );
    // Second revoke is a durable no-op and must not call remote again after terminal revoked.
    expect(officialClient.calls.filter((call) => call.method === 'revokeAccess')).toHaveLength(1);
  });

  it('reconciles intended grants and revokes omitted ones', async () => {
    const { service, officialClient } = createService();
    const resource = videoResource();
    const other = toResourceAuthSubject(
      createAuthUser({
        id: 'user-other',
        displayName: 'Other',
        roles: ['creator'],
        eName: '@other.w3id',
        eVaultId: 'evault-other',
      }),
    );

    await service.grant({
      resource,
      owner,
      subject: grantee,
      scope: 'video:read',
    });
    await service.grant({
      resource,
      owner,
      subject: other,
      scope: 'video:read',
    });

    const results = await service.reconcile({
      resource,
      owner,
      intendedGrants: [{ subject: grantee, scope: 'video:read' }],
    });

    expect(
      results.some((row) => row.subjectEName === grantee.eName && row.syncStatus === 'synced'),
    ).toBe(true);
    expect(
      results.some((row) => row.subjectEName === other.eName && row.syncStatus === 'revoked'),
    ).toBe(true);
    expect(officialClient.hasActiveGrant(resource.resourceId, grantee.eName, 'video:read')).toBe(
      true,
    );
    expect(officialClient.hasActiveGrant(resource.resourceId, other.eName, 'video:read')).toBe(
      false,
    );
  });

  it('fails closed on partial remote failure during grant and never reports synced', async () => {
    const { service, officialClient, store } = createService();
    const resource = videoResource();
    officialClient.failNext('ensureResourceOwner', 'owner bind failed token=abc123secret');

    await expect(
      service.grant({
        resource,
        owner,
        subject: grantee,
        scope: 'video:read',
      }),
    ).rejects.toBeInstanceOf(W3dsAuthorizationSyncError);

    const record = await store.getByResourceSubjectScope(
      resource.resourceId,
      grantee.eName,
      'video:read',
    );
    expect(record?.syncStatus).toBe('failed');
    expect(record?.syncStatus).not.toBe('synced');
    expect(officialClient.hasActiveGrant(resource.resourceId, grantee.eName, 'video:read')).toBe(
      false,
    );
  });

  it('fails closed when W3DS auth configuration is missing', async () => {
    const service = new W3dsAuthorizationSyncService({
      store: new InMemoryW3dsAuthorizationSyncStore(),
      officialClient: new FakeW3dsAuthorizationOfficialClient(),
      w3dsAuthorizationConfigured: false,
    });
    await expect(
      service.grant({
        resource: videoResource(),
        owner,
        subject: grantee,
        scope: 'video:read',
      }),
    ).rejects.toMatchObject({ code: 'configuration_error', status: 503 });
  });

  it('fails closed when no official client is available (production default)', async () => {
    const service = new W3dsAuthorizationSyncService({
      store: new InMemoryW3dsAuthorizationSyncStore(),
      w3dsAuthorizationConfigured: true,
    });
    await expect(
      service.grant({
        resource: videoResource(),
        owner,
        subject: grantee,
        scope: 'video:read',
      }),
    ).rejects.toMatchObject({ code: 'sdk_unavailable', status: 503 });
  });
});

describe('secret redaction', () => {
  it('redacts bearer tokens, JWTs, password-like fields, and credential URLs', () => {
    const redacted = redactAuthorizationFailureReason(
      new Error(
        'POST https://user:pass@evault.example/graphql failed Bearer tok_live_123 with password=hunter2 and eyJhbGciOiJIUzI1NiJ9.aaa.bbb',
      ),
    );
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('tok_live_123');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('user:pass@');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

describe('provider capabilities with sync availability', () => {
  it('keeps W3DS remote sync capabilities false without an official client', () => {
    const config = readResourceAuthorizationConfig({
      AUTH_PROVIDER: 'w3ds',
      W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
      W3DS_AUTH_JWT_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgresql://vidak:vidak@127.0.0.1:5432/vidak',
    });
    const provider = createResourceAuthorizationProvider(config);
    expect(provider.capabilities()).toEqual({
      localPolicyEvaluation: true,
      remoteGrantEvaluation: false,
      remoteGrantMutation: false,
      grantSynchronization: false,
    });
    expect(() => provider.requireCapability('grantSynchronization')).toThrow();
  });

  it('exposes sync capabilities only when an official client is marked available', () => {
    const provider = new W3dsResourceAuthorizationProvider({
      configured: true,
      officialClientAvailable: true,
      missingCapabilities: [],
    });
    expect(provider.capabilities()).toEqual({
      localPolicyEvaluation: true,
      remoteGrantEvaluation: false,
      remoteGrantMutation: true,
      grantSynchronization: true,
    });
  });
});
