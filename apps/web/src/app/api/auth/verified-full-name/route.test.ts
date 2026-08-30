import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEUTRAL_PUBLIC_DISPLAY_NAME } from '../../../../lib/public-display-name';
import * as w3dsAuth from '../../../../server/w3ds-auth';
import {
  InMemoryW3dsAuthStore,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsIdentityVerifier,
} from '../../../../server/w3ds-auth';
import {
  VerifiedFullNameError,
  type VerifiedFullNameReader,
} from '../../../../server/w3ds-verified-full-name';
import { GET, POST } from './route';

const verifiedIdentity: VerifiedW3dsIdentity = {
  eName: '@creator.w3id',
  eVaultId: 'evault-creator',
  eVaultUri: 'https://evault.example/creator',
};

describe('verified full name consent route', () => {
  afterEach(() => {
    resetW3dsAuthServiceForTests();
    vi.restoreAllMocks();
  });

  it('returns 401 for anonymous requests', async () => {
    await expect(
      GET(new NextRequest('https://vidak.example/api/auth/verified-full-name')),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      POST(
        new NextRequest('https://vidak.example/api/auth/verified-full-name', {
          method: 'POST',
          body: JSON.stringify({ grant: true }),
          headers: { 'Content-Type': 'application/json', Origin: 'https://vidak.example' },
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it('does not read the name until the person grants permission', async () => {
    const reader = { readVerifiedFullName: vi.fn() };
    const accessToken = await bootstrap(reader);
    const status = await GET(
      new NextRequest('https://vidak.example/api/auth/verified-full-name', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toEqual({
      eligible: true,
      prompt: true,
      sourceReady: true,
      decision: null,
      reason: 'ready',
    });

    const refused = await POST(
      new NextRequest('https://vidak.example/api/auth/verified-full-name', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          Origin: 'https://vidak.example',
        },
      }),
    );
    expect(refused.status).toBe(400);
    expect(reader.readVerifiedFullName).not.toHaveBeenCalled();
  });

  it('persists the verified name after an explicit grant', async () => {
    const reader: VerifiedFullNameReader = {
      readVerifiedFullName: vi.fn().mockResolvedValue({
        name: 'Ada Lovelace',
        subject: '@creator.w3id',
        type: 'id_document',
      }),
    };
    const accessToken = await bootstrap(reader);
    const response = await POST(
      new NextRequest('https://vidak.example/api/auth/verified-full-name', {
        method: 'POST',
        body: JSON.stringify({ grant: true }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          Origin: 'https://vidak.example',
        },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { displayName: 'Ada Lovelace' },
    });
    expect(reader.readVerifiedFullName).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched identity without changing the stored name', async () => {
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
    const accessToken = await bootstrap(reader);
    const response = await POST(
      new NextRequest('https://vidak.example/api/auth/verified-full-name', {
        method: 'POST',
        body: JSON.stringify({ grant: true }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          Origin: 'https://vidak.example',
        },
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'identity_mismatch', reason: 'identity_mismatch' },
    });
  });
});

async function bootstrap(reader: VerifiedFullNameReader): Promise<string> {
  const verifier: W3dsIdentityVerifier = {
    verify: vi.fn().mockResolvedValue(verifiedIdentity),
  };
  const service = new W3dsAuthService({
    config: {
      platformName: 'vidak',
      registryBaseUrl: 'https://registry.example',
      jwtSecret: 'a development-only test secret with at least 32 characters',
    },
    store: new InMemoryW3dsAuthStore(),
    identityVerifier: verifier,
    verifiedFullNameReader: reader,
    now: () => 1_780_000_000_000,
  });
  vi.spyOn(w3dsAuth, 'getW3dsAuthService').mockReturnValue(service);
  const offer = await service.createOffer('https://vidak.example');
  await service.completeOffer({
    w3id: '@creator.w3id',
    session: offer.sessionId,
    signature: 'signature',
  });
  const cookieSession = await service.getOfferSessionForCookie(offer.offerId);
  const accessToken = cookieSession.tokens.accessToken;
  if (!accessToken) throw new Error('Expected access token');
  expect(cookieSession.user.displayName).toBe(NEUTRAL_PUBLIC_DISPLAY_NAME);
  return accessToken;
}
