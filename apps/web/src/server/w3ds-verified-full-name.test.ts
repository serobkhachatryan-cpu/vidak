import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEUTRAL_PUBLIC_DISPLAY_NAME } from '../lib/public-display-name';
import {
  InMemoryW3dsAuthStore,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsIdentityVerifier,
} from './w3ds-auth';
import {
  extractVerifiedFullNameFromBindingDocuments,
  RegistryVerifiedFullNameReader,
  VerifiedFullNameError,
  type VerifiedFullNameReader,
} from './w3ds-verified-full-name';

const verifiedIdentity: VerifiedW3dsIdentity = {
  eName: '@creator.w3id',
  eVaultId: 'evault-creator',
  eVaultUri: 'https://evault.example/creator',
};

function idDocumentEdge(input: { subject?: string; name: string }) {
  return {
    node: {
      id: 'binding-1',
      parsed: {
        ...(input.subject ? { subject: input.subject } : {}),
        type: 'id_document',
        data: { vendor: 'onfido', reference: 'ref-1', name: input.name },
      },
    },
  };
}

function selfEdge(input: { subject?: string; name: string }) {
  return {
    node: {
      parsed: {
        ...(input.subject ? { subject: input.subject } : {}),
        type: 'self',
        data: { name: input.name },
      },
    },
  };
}

describe('extractVerifiedFullNameFromBindingDocuments', () => {
  it('returns id_document.data.name when subject matches the authenticated eName', () => {
    expect(
      extractVerifiedFullNameFromBindingDocuments({
        authenticatedEName: '@creator.w3id',
        edges: [idDocumentEdge({ subject: '@creator.w3id', name: 'Ada Lovelace' })],
      }),
    ).toEqual({
      name: 'Ada Lovelace',
      subject: '@creator.w3id',
      type: 'id_document',
    });
  });

  it('uses a missing subject as vault-owner scoped, matching eID fetchNameFromVault', () => {
    expect(
      extractVerifiedFullNameFromBindingDocuments({
        authenticatedEName: '@creator.w3id',
        edges: [idDocumentEdge({ name: 'Ada Lovelace' })],
      }),
    ).toMatchObject({ name: 'Ada Lovelace', type: 'id_document' });
  });

  it('rejects a document bound to a different eName', () => {
    expect(() =>
      extractVerifiedFullNameFromBindingDocuments({
        authenticatedEName: '@creator.w3id',
        edges: [idDocumentEdge({ subject: '@other.w3id', name: 'Ada Lovelace' })],
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'identity_mismatch',
        status: 403,
        reason: 'identity_mismatch',
      }),
    );
  });

  it('uses self.data.name when no id_document name is present', () => {
    expect(
      extractVerifiedFullNameFromBindingDocuments({
        authenticatedEName: '@creator.w3id',
        edges: [selfEdge({ subject: '@creator.w3id', name: 'Ada' })],
      }),
    ).toEqual({
      name: 'Ada',
      subject: '@creator.w3id',
      type: 'self',
    });
  });

  it('prefers id_document over self and keeps the full document name', () => {
    expect(
      extractVerifiedFullNameFromBindingDocuments({
        authenticatedEName: '@creator.w3id',
        edges: [
          selfEdge({ subject: '@creator.w3id', name: 'Ada' }),
          idDocumentEdge({ subject: '@creator.w3id', name: 'Ada Lovelace' }),
        ],
      }),
    ).toMatchObject({ name: 'Ada Lovelace', type: 'id_document' });
  });

  it('rejects identifier-shaped verified names', () => {
    expect(() =>
      extractVerifiedFullNameFromBindingDocuments({
        authenticatedEName: '@creator.w3id',
        edges: [
          idDocumentEdge({
            subject: '@creator.w3id',
            name: 'fd10387a-b0d3-5f9c-bf54-7214a491cace',
          }),
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_name' }));
  });
});

describe('RegistryVerifiedFullNameReader', () => {
  it('resolves the vault, then queries id_document and self with X-ENAME', async () => {
    const types: string[] = [];
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/resolve')) {
        expect(href).toContain('w3id=');
        return jsonResponse({ uri: 'https://evault.example/creator', ename: '@creator.w3id' });
      }
      if (href.includes('/platforms/certification')) {
        return jsonResponse({ token: 'platform-token' });
      }
      expect(href).toBe('https://evault.example/graphql');
      expect(init?.headers).toMatchObject({
        'X-ENAME': '@creator.w3id',
        Authorization: 'Bearer platform-token',
      });
      const body = JSON.parse(String(init?.body));
      types.push(body.variables.type);
      expect(body.query).toContain('bindingDocuments(type: $type, first: 10)');
      expect(body.query).toContain('node {');
      expect(body.query).toContain('parsed');
      return jsonResponse({
        data: {
          bindingDocuments: {
            edges:
              body.variables.type === 'id_document'
                ? [idDocumentEdge({ subject: '@creator.w3id', name: 'Ada Lovelace' })]
                : [],
          },
        },
      });
    });

    const reader = new RegistryVerifiedFullNameReader({
      registryBaseUrl: 'https://registry.example',
      platformName: 'vidak',
      fetcher: fetcher as typeof fetch,
    });
    await expect(
      reader.readVerifiedFullName({ eName: '@creator.w3id' }),
    ).resolves.toMatchObject({ name: 'Ada Lovelace', subject: '@creator.w3id' });
    expect(types.sort()).toEqual(['id_document', 'self']);
  });

  it('falls back to self then the User ontology displayName', async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/resolve')) {
        return jsonResponse({ uri: 'https://evault.example/creator' });
      }
      if (href.includes('/platforms/certification')) {
        return jsonResponse({ token: 'platform-token' });
      }
      const body = JSON.parse(String(init?.body));
      if (body.variables?.type === 'id_document') {
        return jsonResponse({ data: { bindingDocuments: { edges: [] } } });
      }
      if (body.variables?.type === 'self') {
        return jsonResponse({ data: { bindingDocuments: { edges: [] } } });
      }
      expect(body.variables).toEqual({ ontologyId: '550e8400-e29b-41d4-a716-446655440000' });
      return jsonResponse({
        data: {
          metaEnvelopes: {
            edges: [{ node: { parsed: { displayName: 'Ada Lovelace' } } }],
          },
        },
      });
    });
    const reader = new RegistryVerifiedFullNameReader({
      registryBaseUrl: 'https://registry.example',
      platformName: 'vidak',
      fetcher: fetcher as typeof fetch,
    });
    await expect(reader.readVerifiedFullName({ eName: '@creator.w3id' })).resolves.toMatchObject({
      name: 'Ada Lovelace',
      type: 'user_profile',
    });
  });

  it('maps GraphQL ACL failures to authorization_denied, not name_unavailable', async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.includes('/resolve')) return jsonResponse({ uri: 'https://evault.example/creator' });
      if (href.includes('/platforms/certification')) return jsonResponse({ token: 'platform-token' });
      return jsonResponse({
        errors: [{ message: 'denied', extensions: { code: 'FORBIDDEN' } }],
      });
    });
    const reader = new RegistryVerifiedFullNameReader({
      registryBaseUrl: 'https://registry.example',
      platformName: 'vidak',
      fetcher: fetcher as typeof fetch,
    });
    await expect(reader.readVerifiedFullName({ eName: '@creator.w3id' })).rejects.toMatchObject({
      code: 'authorization_denied',
      reason: 'authorization_denied',
      status: 403,
    });
  });

  it('maps HTTP 403 to authorization_denied', async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.includes('/resolve')) return jsonResponse({ uri: 'https://evault.example/creator' });
      if (href.includes('/platforms/certification')) return jsonResponse({ token: 'platform-token' });
      return new Response('forbidden', { status: 403 });
    });
    const reader = new RegistryVerifiedFullNameReader({
      registryBaseUrl: 'https://registry.example',
      platformName: 'vidak',
      fetcher: fetcher as typeof fetch,
    });
    await expect(reader.readVerifiedFullName({ eName: '@creator.w3id' })).rejects.toMatchObject({
      code: 'authorization_denied',
      status: 403,
    });
  });

  it('uses a stored vault URI when Registry resolve fails', async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/resolve')) return new Response('down', { status: 503 });
      if (href.includes('/platforms/certification')) return jsonResponse({ token: 'platform-token' });
      expect(href).toBe('https://evault.example/graphql');
      const body = JSON.parse(String(init?.body));
      if (body.variables?.type === 'id_document') {
        return jsonResponse({
          data: {
            bindingDocuments: {
              edges: [idDocumentEdge({ subject: '@creator.w3id', name: 'Ada Lovelace' })],
            },
          },
        });
      }
      return jsonResponse({ data: { bindingDocuments: { edges: [] } } });
    });
    const reader = new RegistryVerifiedFullNameReader({
      registryBaseUrl: 'https://registry.example',
      platformName: 'vidak',
      fetcher: fetcher as typeof fetch,
    });
    await expect(
      reader.readVerifiedFullName({
        eName: '@creator.w3id',
        eVaultUri: 'https://evault.example/creator',
      }),
    ).resolves.toMatchObject({ name: 'Ada Lovelace' });
  });
});

describe('verified full name consent and persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not read the eVault during login', async () => {
    const reader = { readVerifiedFullName: vi.fn() };
    const { service } = createService(reader);
    const offer = await service.createOffer('https://vidak.example');
    await service.completeOffer({
      w3id: '@creator.w3id',
      session: offer.sessionId,
      signature: 'signature',
    });
    const cookie = await service.getOfferSessionForCookie(offer.offerId);
    expect(cookie.user.displayName).toBe(NEUTRAL_PUBLIC_DISPLAY_NAME);
    expect(reader.readVerifiedFullName).not.toHaveBeenCalled();
    const accessToken = cookie.tokens.accessToken;
    if (!accessToken) throw new Error('Expected access token');
    await expect(service.getVerifiedFullNameConsent(accessToken)).resolves.toEqual({
      eligible: true,
      prompt: true,
      sourceReady: true,
      decision: null,
      reason: 'ready',
    });
  });

  it('refuses to read the name without an explicit grant', async () => {
    const reader = { readVerifiedFullName: vi.fn() };
    const { service, accessToken } = await authenticatedService(reader);
    await expect(
      service.applyVerifiedFullName(accessToken, { grant: false }),
    ).rejects.toMatchObject({
      code: 'consent_required',
      status: 400,
    });
    expect(reader.readVerifiedFullName).not.toHaveBeenCalled();
  });

  it('persists the verified name after consent when identity matches', async () => {
    const reader: VerifiedFullNameReader = {
      readVerifiedFullName: vi.fn().mockResolvedValue({
        name: 'Ada Lovelace',
        subject: '@creator.w3id',
        type: 'id_document',
      }),
    };
    const { service, accessToken } = await authenticatedService(reader);
    const user = await service.applyVerifiedFullName(accessToken, { grant: true });
    expect(user.displayName).toBe('Ada Lovelace');
    expect(reader.readVerifiedFullName).toHaveBeenCalledWith({
      eName: '@creator.w3id',
      eVaultUri: 'https://evault.example/creator',
    });
    await expect(service.getVerifiedFullNameConsent(accessToken)).resolves.toEqual({
      eligible: false,
      prompt: false,
      sourceReady: true,
      decision: 'granted',
      reason: 'ready',
    });
  });

  it('still looks up the name when no stored eVaultUri is present', async () => {
    const reader: VerifiedFullNameReader = {
      readVerifiedFullName: vi.fn().mockResolvedValue({
        name: 'Ada Lovelace',
        subject: '@creator.w3id',
        type: 'self',
      }),
    };
    const { service, accessToken } = await authenticatedService(reader);
    await service.applyVerifiedFullName(accessToken, { grant: true });
    expect(reader.readVerifiedFullName).toHaveBeenCalled();
  });

  it('does not map unknown reader failures to name_unavailable', async () => {
    const reader: VerifiedFullNameReader = {
      readVerifiedFullName: vi.fn().mockRejectedValue(new Error('network')),
    };
    const { service, accessToken } = await authenticatedService(reader);
    await expect(service.applyVerifiedFullName(accessToken, { grant: true })).rejects.toMatchObject({
      code: 'remote_unavailable',
      reason: 'source_unavailable',
      status: 503,
    });
  });

  it('rejects a mismatched identity and leaves the placeholder name', async () => {
    const reader: VerifiedFullNameReader = {
      readVerifiedFullName: vi
        .fn()
        .mockRejectedValue(
          new VerifiedFullNameError(
            'The identity document does not belong to this eName.',
            'identity_mismatch',
            403,
          ),
        ),
    };
    const { service, accessToken } = await authenticatedService(reader);
    await expect(service.applyVerifiedFullName(accessToken, { grant: true })).rejects.toMatchObject(
      {
        code: 'identity_mismatch',
        status: 403,
      },
    );
    const session = await service.getSession(accessToken);
    expect(session.user.displayName).toBe(NEUTRAL_PUBLIC_DISPLAY_NAME);
  });

  it('rejects a reader result bound to a different eName', async () => {
    const reader: VerifiedFullNameReader = {
      readVerifiedFullName: vi.fn().mockResolvedValue({
        name: 'Ada Lovelace',
        subject: '@other.w3id',
        type: 'id_document',
      }),
    };
    const { service, accessToken } = await authenticatedService(reader);
    await expect(service.applyVerifiedFullName(accessToken, { grant: true })).rejects.toMatchObject(
      {
        code: 'identity_mismatch',
        status: 403,
      },
    );
    const session = await service.getSession(accessToken);
    expect(session.user.displayName).toBe(NEUTRAL_PUBLIC_DISPLAY_NAME);
  });

  it('does not overwrite a manually chosen public name', async () => {
    const reader: VerifiedFullNameReader = {
      readVerifiedFullName: vi.fn().mockResolvedValue({
        name: 'Ada Lovelace',
        subject: '@creator.w3id',
        type: 'id_document',
      }),
    };
    const { service, accessToken } = await authenticatedService(reader);
    await service.updateProfile(accessToken, { displayName: 'Ada Chosen' });
    await expect(service.applyVerifiedFullName(accessToken, { grant: true })).rejects.toMatchObject(
      {
        code: 'name_not_replaceable',
        status: 409,
      },
    );
    expect(reader.readVerifiedFullName).toHaveBeenCalled();
    const session = await service.getSession(accessToken);
    expect(session.user.displayName).toBe('Ada Chosen');
  });

  it('upgrades a first-name grant to the full verified document name', async () => {
    const reader: VerifiedFullNameReader = {
      readVerifiedFullName: vi.fn().mockResolvedValue({
        name: 'Ada Lovelace',
        subject: '@creator.w3id',
        type: 'id_document',
      }),
    };
    const { service, accessToken } = await authenticatedService(reader);
    await service.updateProfile(accessToken, { displayName: 'Ada' });
    const user = await service.applyVerifiedFullName(accessToken, { grant: true });
    expect(user.displayName).toBe('Ada Lovelace');
  });

  it('records a decline without reading or changing the name', async () => {
    const reader = {
      readVerifiedFullName: vi.fn().mockResolvedValue({
        name: 'Ada Lovelace',
        subject: '@creator.w3id',
        type: 'id_document',
      }),
    };
    const { service, accessToken } = await authenticatedService(reader);
    const user = await service.declineVerifiedFullName(accessToken);
    expect(user.displayName).toBe(NEUTRAL_PUBLIC_DISPLAY_NAME);
    expect(reader.readVerifiedFullName).not.toHaveBeenCalled();
    await expect(service.getVerifiedFullNameConsent(accessToken)).resolves.toEqual({
      eligible: true,
      prompt: false,
      sourceReady: true,
      decision: 'declined',
      reason: 'ready',
    });
    const userAfterGrant = await service.applyVerifiedFullName(accessToken, { grant: true });
    expect(userAfterGrant.displayName).toBe('Ada Lovelace');
  });

  it('keeps identifier and placeholder names eligible when a reader is configured', async () => {
    const reader = {
      readVerifiedFullName: vi.fn().mockResolvedValue({
        name: 'Ada Lovelace',
        subject: '@creator.w3id',
        type: 'id_document',
      }),
    };
    const { service, accessToken } = await authenticatedService(reader);
    await expect(service.getVerifiedFullNameConsent(accessToken)).resolves.toMatchObject({
      eligible: true,
      prompt: true,
      sourceReady: true,
      reason: 'ready',
    });
  });

  it('reports an unready name source without pretending the person is ineligible', async () => {
    const { service, accessToken } = await authenticatedService();
    await expect(service.getVerifiedFullNameConsent(accessToken)).resolves.toEqual({
      eligible: false,
      prompt: false,
      sourceReady: false,
      decision: null,
      reason: 'source_unconfigured',
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createService(reader?: VerifiedFullNameReader) {
  const verifier: W3dsIdentityVerifier = {
    verify: vi.fn().mockResolvedValue(verifiedIdentity),
  };
  const store = new InMemoryW3dsAuthStore();
  return {
    store,
    service: new W3dsAuthService({
      config: {
        platformName: 'vidak',
        registryBaseUrl: 'https://registry.example',
        jwtSecret: 'a development-only test secret with at least 32 characters',
      },
      store,
      identityVerifier: verifier,
      ...(reader ? { verifiedFullNameReader: reader } : {}),
      now: () => 1_780_000_000_000,
    }),
  };
}

async function authenticatedService(reader?: VerifiedFullNameReader) {
  const { service } = createService(reader);
  const offer = await service.createOffer('https://vidak.example');
  await service.completeOffer({
    w3id: '@creator.w3id',
    session: offer.sessionId,
    signature: 'signature',
  });
  const cookie = await service.getOfferSessionForCookie(offer.offerId);
  const accessToken = cookie.tokens.accessToken;
  if (!accessToken) throw new Error('Expected access token');
  return { service, accessToken };
}
