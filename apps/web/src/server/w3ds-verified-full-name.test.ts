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

function idDocumentEdge(input: { subject: string; name: string }) {
  return {
    node: {
      id: 'binding-1',
      parsed: {
        subject: input.subject,
        type: 'id_document',
        data: { vendor: 'onfido', reference: 'ref-1', name: input.name },
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
      }),
    );
  });

  it('ignores self documents and User ontology fields', () => {
    expect(() =>
      extractVerifiedFullNameFromBindingDocuments({
        authenticatedEName: '@creator.w3id',
        edges: [
          {
            node: {
              parsed: { subject: '@creator.w3id', type: 'self', data: { name: 'Ada' } },
            },
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'name_unavailable' }));
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
  it('queries only id_document with X-ENAME of the authenticated person', async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/platforms/certification')) {
        return jsonResponse({ token: 'platform-token' });
      }
      expect(href).toBe('https://evault.example/graphql');
      expect(init?.headers).toMatchObject({
        'X-ENAME': '@creator.w3id',
        Authorization: 'Bearer platform-token',
      });
      const body = JSON.parse(String(init?.body));
      expect(body.variables).toEqual({ type: 'id_document' });
      expect(body.query).toContain('bindingDocuments(type: $type, first: 10)');
      return jsonResponse({
        data: {
          bindingDocuments: {
            edges: [idDocumentEdge({ subject: '@creator.w3id', name: 'Ada Lovelace' })],
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
      reader.readVerifiedFullName({
        eName: '@creator.w3id',
        eVaultUri: 'https://evault.example/creator',
      }),
    ).resolves.toMatchObject({ name: 'Ada Lovelace', subject: '@creator.w3id' });
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
      decision: null,
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
      decision: 'granted',
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
    expect(reader.readVerifiedFullName).not.toHaveBeenCalled();
    const session = await service.getSession(accessToken);
    expect(session.user.displayName).toBe('Ada Chosen');
  });

  it('records a decline without reading or changing the name', async () => {
    const reader = { readVerifiedFullName: vi.fn() };
    const { service, accessToken } = await authenticatedService(reader);
    const user = await service.declineVerifiedFullName(accessToken);
    expect(user.displayName).toBe(NEUTRAL_PUBLIC_DISPLAY_NAME);
    expect(reader.readVerifiedFullName).not.toHaveBeenCalled();
    await expect(service.getVerifiedFullNameConsent(accessToken)).resolves.toEqual({
      eligible: false,
      decision: 'declined',
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createService(reader: VerifiedFullNameReader) {
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
      verifiedFullNameReader: reader,
      now: () => 1_780_000_000_000,
    }),
  };
}

async function authenticatedService(reader: VerifiedFullNameReader) {
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
