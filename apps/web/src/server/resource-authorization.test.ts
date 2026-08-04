import { createAuthUser } from '@w3ds/auth';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anonymousPrincipal,
  authenticatedPrincipal,
  createMediaResourceDescriptor,
  createResourceAuthorizationProvider,
  createResourceRef,
  createVideoResourceDescriptor,
  evaluateLocalResourcePolicy,
  getResourceAuthorizationProvider,
  LocalResourceAuthorizationProvider,
  ResourceAuthorizationError,
  type ResourceDescriptor,
  readResourceAuthorizationConfig,
  resetResourceAuthorizationProviderForTests,
  resolveResourceRef,
  toResourceAuthSubject,
  W3dsResourceAuthorizationProvider,
} from './resource-authorization';

const ownerUser = createAuthUser({
  id: 'user-owner',
  displayName: 'Owner',
  roles: ['creator'],
  eName: '@owner.w3id',
  eVaultId: 'evault-owner',
});

const otherUser = createAuthUser({
  id: 'user-other',
  displayName: 'Other',
  roles: ['creator'],
  eName: '@other.w3id',
  eVaultId: 'evault-other',
});

function video(
  overrides: Partial<{
    localId: string;
    visibility: ResourceDescriptor['visibility'];
    status: ResourceDescriptor['status'];
    publicVideoId: string;
  }> = {},
): ResourceDescriptor {
  return createVideoResourceDescriptor({
    localId: 'video-1',
    owner: { platformUserId: ownerUser.id, eName: ownerUser.eName },
    visibility: 'private',
    status: 'draft',
    ...overrides,
  });
}

function media(
  overrides: Partial<{
    localId: string;
    parentVideoLocalId: string;
    visibility: ResourceDescriptor['visibility'];
    status: ResourceDescriptor['status'];
    publicVideoId: string;
  }> = {},
): ResourceDescriptor {
  return createMediaResourceDescriptor({
    localId: 'asset-1',
    parentVideoLocalId: 'video-1',
    owner: { platformUserId: ownerUser.id, eName: ownerUser.eName },
    visibility: 'private',
    status: 'draft',
    ...overrides,
  });
}

afterEach(() => {
  resetResourceAuthorizationProviderForTests();
});

describe('resource authorization subjects', () => {
  it('uses authenticated W3DS identity fields as the canonical subject', () => {
    expect(toResourceAuthSubject(ownerUser)).toEqual({
      platformUserId: 'user-owner',
      eName: '@owner.w3id',
      eVaultId: 'evault-owner',
    });
  });

  it('rejects missing platform user id, eName, or eVault id', () => {
    expect(() => toResourceAuthSubject({ ...ownerUser, id: '' })).toThrowError(
      ResourceAuthorizationError,
    );
    expect(() => toResourceAuthSubject({ ...ownerUser, eName: 'not-an-ename' })).toThrowError(
      ResourceAuthorizationError,
    );
    expect(() => toResourceAuthSubject({ ...ownerUser, eVaultId: '   ' })).toThrowError(
      ResourceAuthorizationError,
    );
  });

  it('never treats email as an authorization subject', () => {
    const subject = toResourceAuthSubject({
      ...ownerUser,
      email: 'owner@example.com',
    });
    expect(subject).not.toHaveProperty('email');
    expect(Object.keys(subject).sort()).toEqual(['eName', 'eVaultId', 'platformUserId']);
  });
});

describe('opaque resource identifiers', () => {
  it('creates stable opaque ids and round-trips local mappings', () => {
    const first = createResourceRef('creator_video', 'video-1');
    const second = createResourceRef('creator_video', 'video-1');
    expect(first).toEqual(second);
    expect(first.resourceId.startsWith('vra_1_v_')).toBe(true);
    expect(first.resourceId.includes('video-1')).toBe(false);
    expect(resolveResourceRef(first.resourceId)).toEqual(first);
  });

  it('distinguishes video and media resource kinds', () => {
    const videoRef = createResourceRef('creator_video', 'shared-id');
    const mediaRef = createResourceRef('media_asset', 'shared-id');
    expect(videoRef.resourceId).not.toEqual(mediaRef.resourceId);
    expect(resolveResourceRef(videoRef.resourceId)?.kind).toBe('creator_video');
    expect(resolveResourceRef(mediaRef.resourceId)?.kind).toBe('media_asset');
  });

  it('rejects tampered or empty resource identifiers', () => {
    const ref = createResourceRef('creator_video', 'video-1');
    expect(resolveResourceRef(`${ref.resourceId}x`)).toBeUndefined();
    expect(resolveResourceRef('not-a-resource-id')).toBeUndefined();
    expect(() => createResourceRef('creator_video', '  ')).toThrowError(ResourceAuthorizationError);
  });
});

describe('local ownership and visibility policy', () => {
  it('allows owners and denies cross-user owner scopes without disclosing details', () => {
    const resource = video();
    expect(
      evaluateLocalResourcePolicy({
        principal: authenticatedPrincipal(ownerUser),
        resource,
        scope: 'video:owner',
      }),
    ).toEqual({ allowed: true, reason: 'owner' });
    expect(
      evaluateLocalResourcePolicy({
        principal: authenticatedPrincipal(otherUser),
        resource,
        scope: 'video:owner',
      }),
    ).toEqual({ allowed: false, reason: 'not_owner' });
    expect(
      evaluateLocalResourcePolicy({
        principal: anonymousPrincipal(),
        resource,
        scope: 'video:owner',
      }),
    ).toEqual({ allowed: false, reason: 'anonymous_denied' });
  });

  it('preserves public / unlisted / private anonymous read behavior', () => {
    const cases = [
      {
        visibility: 'public' as const,
        status: 'published' as const,
        scope: 'video:read' as const,
        allowed: true,
        reason: 'published_public' as const,
      },
      {
        visibility: 'unlisted' as const,
        status: 'published' as const,
        scope: 'video:read' as const,
        allowed: true,
        reason: 'published_unlisted' as const,
      },
      {
        visibility: 'private' as const,
        status: 'published' as const,
        scope: 'video:read' as const,
        allowed: false,
        reason: 'private_visibility' as const,
      },
      {
        visibility: 'public' as const,
        status: 'draft' as const,
        scope: 'video:read' as const,
        allowed: false,
        reason: 'not_published' as const,
      },
    ];

    for (const testCase of cases) {
      expect(
        evaluateLocalResourcePolicy({
          principal: anonymousPrincipal(),
          resource: video({
            visibility: testCase.visibility,
            status: testCase.status,
          }),
          scope: testCase.scope,
        }),
      ).toEqual({ allowed: testCase.allowed, reason: testCase.reason });
    }
  });

  it('limits anonymous discovery to published public videos only', () => {
    expect(
      evaluateLocalResourcePolicy({
        principal: anonymousPrincipal(),
        resource: video({ visibility: 'public', status: 'published' }),
        scope: 'video:discover',
      }),
    ).toEqual({ allowed: true, reason: 'published_public' });
    expect(
      evaluateLocalResourcePolicy({
        principal: anonymousPrincipal(),
        resource: video({ visibility: 'unlisted', status: 'published' }),
        scope: 'video:discover',
      }).allowed,
    ).toBe(false);
    expect(
      evaluateLocalResourcePolicy({
        principal: anonymousPrincipal(),
        resource: video({ visibility: 'public', status: 'draft' }),
        scope: 'video:discover',
      }),
    ).toEqual({ allowed: false, reason: 'not_published' });
  });

  it('applies the same visibility rules to media read scopes', () => {
    expect(
      evaluateLocalResourcePolicy({
        principal: authenticatedPrincipal(ownerUser),
        resource: media(),
        scope: 'media:owner',
      }),
    ).toEqual({ allowed: true, reason: 'owner' });
    expect(
      evaluateLocalResourcePolicy({
        principal: anonymousPrincipal(),
        resource: media({ visibility: 'unlisted', status: 'published' }),
        scope: 'media:read',
      }),
    ).toEqual({ allowed: true, reason: 'published_unlisted' });
    expect(
      evaluateLocalResourcePolicy({
        principal: anonymousPrincipal(),
        resource: media({ visibility: 'private', status: 'published' }),
        scope: 'media:read',
      }),
    ).toEqual({ allowed: false, reason: 'private_visibility' });
  });

  it('rejects scope/kind mismatches', () => {
    expect(
      evaluateLocalResourcePolicy({
        principal: authenticatedPrincipal(ownerUser),
        resource: video(),
        scope: 'media:owner',
      }),
    ).toEqual({ allowed: false, reason: 'scope_mismatch' });
    expect(
      evaluateLocalResourcePolicy({
        principal: anonymousPrincipal(),
        resource: media({ visibility: 'public', status: 'published' }),
        scope: 'video:discover',
      }),
    ).toEqual({ allowed: false, reason: 'scope_mismatch' });
  });
});

describe('authorization providers and capabilities', () => {
  it('keeps the local/dev provider explicit without W3DS remote capabilities', async () => {
    const provider = new LocalResourceAuthorizationProvider();
    expect(provider.id).toBe('local');
    expect(provider.capabilities()).toEqual({
      localPolicyEvaluation: true,
      remoteGrantEvaluation: false,
      remoteGrantMutation: false,
      grantSynchronization: false,
    });
    await expect(
      provider.authorize({
        principal: authenticatedPrincipal(ownerUser),
        resource: video(),
        scope: 'video:owner',
      }),
    ).resolves.toEqual({ allowed: true, reason: 'owner' });
    expect(() => provider.requireCapability('remoteGrantEvaluation')).toThrow(
      ResourceAuthorizationError,
    );
    try {
      provider.requireCapability('remoteGrantEvaluation');
    } catch (error) {
      expect(error).toMatchObject({ code: 'capability_unavailable', status: 503 });
    }
  });

  it('constructs a W3DS provider only when configured and still fail-closes remote capabilities', async () => {
    expect(() => new W3dsResourceAuthorizationProvider({ configured: false })).toThrow(
      ResourceAuthorizationError,
    );
    try {
      new W3dsResourceAuthorizationProvider({ configured: false });
    } catch (error) {
      expect(error).toMatchObject({ code: 'configuration_error', status: 503 });
    }

    const provider = new W3dsResourceAuthorizationProvider({ configured: true });
    expect(provider.id).toBe('w3ds');
    expect(provider.capabilities()).toEqual({
      localPolicyEvaluation: true,
      remoteGrantEvaluation: false,
      remoteGrantMutation: false,
      grantSynchronization: false,
    });
    await expect(
      provider.authorize({
        principal: anonymousPrincipal(),
        resource: video({ visibility: 'public', status: 'published' }),
        scope: 'video:read',
      }),
    ).resolves.toEqual({ allowed: true, reason: 'published_public' });
    expect(() => provider.requireCapability('grantSynchronization')).toThrow(
      ResourceAuthorizationError,
    );
  });

  it('selects local authz for the development auth provider', () => {
    const config = readResourceAuthorizationConfig({
      AUTH_PROVIDER: 'dev',
      W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
      W3DS_AUTH_JWT_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgresql://vidak:vidak@127.0.0.1:5432/vidak',
    });
    expect(config.provider).toBe('local');
    expect(config.w3dsAuthorizationConfigured).toBe(true);
    expect(config.w3dsOfficialAuthorizationClientAvailable).toBe(false);
    expect(config.w3dsAuthorizationMissingCapabilities.length).toBeGreaterThan(0);
    expect(createResourceAuthorizationProvider(config).id).toBe('local');
  });

  it('fails closed when W3DS authz is selected without W3DS auth configuration', () => {
    const config = readResourceAuthorizationConfig({
      AUTH_PROVIDER: 'w3ds',
    });
    expect(config.provider).toBe('w3ds');
    expect(config.w3dsAuthorizationConfigured).toBe(false);
    expect(() => createResourceAuthorizationProvider(config)).toThrow(ResourceAuthorizationError);
    try {
      createResourceAuthorizationProvider(config);
    } catch (error) {
      expect(error).toMatchObject({ code: 'configuration_error', status: 503 });
    }
  });

  it('creates the W3DS provider when auth configuration is present without granting remote powers', () => {
    const config = readResourceAuthorizationConfig({
      AUTH_PROVIDER: 'w3ds',
      W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
      W3DS_AUTH_JWT_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgresql://vidak:vidak@127.0.0.1:5432/vidak',
    });
    const provider = createResourceAuthorizationProvider(config);
    expect(provider.id).toBe('w3ds');
    expect(provider.capabilities().remoteGrantMutation).toBe(false);
    expect(provider.capabilities().remoteGrantEvaluation).toBe(false);
    expect(provider.capabilities().grantSynchronization).toBe(false);
  });

  it('rejects unsafe authenticated principals during provider authorize', async () => {
    const provider = new LocalResourceAuthorizationProvider();
    await expect(
      provider.authorize({
        principal: {
          kind: 'authenticated',
          subject: {
            platformUserId: 'user-owner',
            eName: 'missing-at',
            eVaultId: 'evault-owner',
          },
        },
        resource: video(),
        scope: 'video:owner',
      }),
    ).rejects.toMatchObject({ code: 'invalid_subject', status: 401 });
  });

  it('exposes a resettable process singleton for later wiring', () => {
    const first = createResourceAuthorizationProvider({
      provider: 'local',
      w3dsAuthorizationConfigured: false,
      w3dsOfficialAuthorizationClientAvailable: false,
      w3dsAuthorizationMissingCapabilities: [],
    });
    expect(first.id).toBe('local');
    // Singleton uses process env; default AUTH_PROVIDER resolves to local/dev.
    const singleton = getResourceAuthorizationProvider();
    expect(singleton.id).toBe('local');
    resetResourceAuthorizationProviderForTests();
    expect(getResourceAuthorizationProvider()).not.toBe(singleton);
  });
});
