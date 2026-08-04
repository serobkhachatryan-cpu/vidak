import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as w3dsAuth from '../../../server/w3ds-auth';
import {
  InMemoryW3dsAuthStore,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsIdentityVerifier,
} from '../../../server/w3ds-auth';
import { PATCH as updateProfile } from './profile/route';
import { DELETE as deleteSession } from './sessions/[sessionId]/route';
import { GET as listSessions } from './sessions/route';

const verifiedIdentity: VerifiedW3dsIdentity = {
  eName: '@creator.w3id',
  eVaultId: 'evault-creator',
  eVaultUri: 'https://evault.example/creator',
};

describe('W3DS account API routes', () => {
  afterEach(() => {
    resetW3dsAuthServiceForTests();
    vi.restoreAllMocks();
  });

  it('returns 401 for anonymous profile and session requests', async () => {
    const anonymous = new NextRequest('https://vidak.example/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Anon' }),
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(updateProfile(anonymous)).resolves.toMatchObject({ status: 401 });
    await expect(
      listSessions(new NextRequest('https://vidak.example/api/auth/sessions')),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      deleteSession(new NextRequest('https://vidak.example/api/auth/sessions/session-1'), {
        params: Promise.resolve({ sessionId: 'session-1' }),
      }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it('updates profile for an authenticated bearer session', async () => {
    const accessToken = await bootstrapAuthenticatedService();
    const response = await updateProfile(
      new NextRequest('https://vidak.example/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Route Updated' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      displayName: 'Route Updated',
      profile: { displayName: 'Route Updated' },
    });
  });
});

async function bootstrapAuthenticatedService(): Promise<string> {
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
  return accessToken;
}
