import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLoginPath } from '../../../features/auth/auth-session-handoff';
import { resolvePublicOrigin } from '../../../server/public-origin';
import * as w3dsAuth from '../../../server/w3ds-auth';
import {
  InMemoryW3dsAuthStore,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsIdentityVerifier,
  w3dsAccessCookieName,
} from '../../../server/w3ds-auth';
import { GET as handoff } from './route';

const verifiedIdentity: VerifiedW3dsIdentity = {
  eName: '@creator.w3id',
  eVaultId: 'evault-creator',
  eVaultUri: 'https://evault.example/creator',
};

const appOrigin = 'https://vidak.postplatforms.com';

describe('auth handoff route', () => {
  afterEach(() => {
    resetW3dsAuthServiceForTests();
    vi.restoreAllMocks();
  });

  it('uses the configured public origin behind the reverse proxy', () => {
    const request = new NextRequest('http://localhost:3910/auth/handoff?returnTo=/settings');
    expect(
      resolvePublicOrigin(request, {
        trustedOrigins: [appOrigin],
      }),
    ).toBe(appOrigin);
  });

  it('redirects to returnTo after verifying the continuation cookie session', async () => {
    const { accessToken } = await bootstrapSession();
    const response = await handoff(
      new NextRequest(`${appOrigin}/auth/handoff?returnTo=/settings`, {
        headers: { Cookie: `${w3dsAccessCookieName}=${accessToken}` },
      }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${appOrigin}/settings`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('normalizes handoff/login returnTo values and rejects missing cookies', async () => {
    const anonymous = await handoff(
      new NextRequest(`${appOrigin}/auth/handoff?returnTo=${encodeURIComponent('/auth/handoff')}`),
    );
    expect(anonymous.headers.get('location')).toBe(`${appOrigin}${buildLoginPath('/')}`);

    const { accessToken } = await bootstrapSession();
    const loopSafe = await handoff(
      new NextRequest(`${appOrigin}/auth/handoff?returnTo=${encodeURIComponent('/login')}`, {
        headers: { Cookie: `${w3dsAccessCookieName}=${accessToken}` },
      }),
    );
    expect(loopSafe.headers.get('location')).toBe(`${appOrigin}/`);
  });
});

async function bootstrapSession() {
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

  const offer = await service.createOffer(appOrigin);
  await service.completeOffer({
    w3id: '@creator.w3id',
    session: offer.sessionId,
    signature: 'signature',
  });
  const cookieSession = await service.getOfferSessionForCookie(offer.offerId);
  const accessToken = cookieSession.tokens.accessToken;
  if (!accessToken) throw new Error('Expected access token');
  return { accessToken };
}
