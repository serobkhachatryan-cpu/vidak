import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PATCH as updateProfile } from '../app/api/auth/profile/route';
import { GET as listPublicVideos } from '../app/api/videos/public/route';
import * as creatorVideo from './creator-video';
import {
  assertTrustedMutationOrigin,
  isTrustedMutationOrigin,
  readRequestOriginCandidate,
  responseAllowsCredentialedCors,
} from './request-security';
import { loadServerSecurityConfig } from './server-config';
import * as w3dsAuth from './w3ds-auth';
import {
  InMemoryW3dsAuthStore,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsIdentityVerifier,
  w3dsAccessCookieName,
  w3dsCookieOptions,
} from './w3ds-auth';

const verifiedIdentity: VerifiedW3dsIdentity = {
  eName: '@creator.w3id',
  eVaultId: 'evault-creator',
  eVaultUri: 'https://evault.example/creator',
};

describe('request security boundaries', () => {
  afterEach(() => {
    resetW3dsAuthServiceForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('accepts same-origin and configured trusted origins for cookie mutations', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'development',
      AUTH_PROVIDER: 'dev',
      APP_ORIGIN: 'https://vidak.example',
      TRUSTED_ORIGINS: 'https://preview.vidak.example',
    });

    expect(
      isTrustedMutationOrigin(
        'https://vidak.example',
        'https://vidak.example',
        config.trustedOrigins,
      ),
    ).toBe(true);
    expect(
      isTrustedMutationOrigin(
        'https://preview.vidak.example',
        'https://vidak.example',
        config.trustedOrigins,
      ),
    ).toBe(true);
    expect(
      isTrustedMutationOrigin(
        'https://evil.example',
        'https://vidak.example',
        config.trustedOrigins,
      ),
    ).toBe(false);

    expect(() =>
      assertTrustedMutationOrigin(
        {
          headers: new Headers({ Origin: 'https://evil.example' }),
          url: 'https://vidak.example/api/auth/profile',
        },
        config,
      ),
    ).toThrow(/not trusted/);
  });

  it('skips origin validation for bearer-authenticated mutations', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'development',
      AUTH_PROVIDER: 'dev',
      APP_ORIGIN: 'https://vidak.example',
    });

    expect(() =>
      assertTrustedMutationOrigin(
        {
          headers: new Headers({
            Authorization: 'Bearer server-token',
            Origin: 'https://evil.example',
          }),
          url: 'https://vidak.example/api/auth/profile',
        },
        config,
      ),
    ).not.toThrow();
  });

  it('rejects cookie mutations without Origin/Referer', () => {
    const config = loadServerSecurityConfig({
      NODE_ENV: 'development',
      AUTH_PROVIDER: 'dev',
    });

    expect(() =>
      assertTrustedMutationOrigin(
        {
          headers: new Headers(),
          url: 'https://vidak.example/api/auth/profile',
        },
        config,
      ),
    ).toThrow(/Trusted request origin is required/);

    expect(
      readRequestOriginCandidate(new Headers({ Referer: 'https://vidak.example/settings' })),
    ).toBe('https://vidak.example');
  });

  it('rejects untrusted cookie profile mutations and allows trusted cookie + bearer', async () => {
    const accessToken = await bootstrapAuthenticatedService();

    const untrusted = await updateProfile(
      new NextRequest('https://vidak.example/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Hijacked' }),
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${w3dsAccessCookieName}=${accessToken}`,
          Origin: 'https://evil.example',
        },
      }),
    );
    expect(untrusted.status).toBe(403);
    await expect(untrusted.json()).resolves.toMatchObject({
      error: { code: 'untrusted_origin' },
    });
    expect(untrusted.headers.get('access-control-allow-origin')).toBeNull();
    expect(untrusted.headers.get('access-control-allow-credentials')).toBeNull();
    expect(responseAllowsCredentialedCors(untrusted.headers)).toBe(false);

    const trustedCookie = await updateProfile(
      new NextRequest('https://vidak.example/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Trusted Cookie' }),
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${w3dsAccessCookieName}=${accessToken}`,
          Origin: 'https://vidak.example',
        },
      }),
    );
    expect(trustedCookie.status).toBe(200);

    const bearerCrossOrigin = await updateProfile(
      new NextRequest('https://vidak.example/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName: 'Bearer Client' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          Origin: 'https://evil.example',
        },
      }),
    );
    expect(bearerCrossOrigin.status).toBe(200);
  });

  it('leaves anonymous public read routes unaffected by mutation origin checks', async () => {
    vi.spyOn(creatorVideo, 'getCreatorVideoService').mockReturnValue({
      listPublicVideos: vi.fn().mockResolvedValue({ items: [] }),
    } as never);

    const response = await listPublicVideos(
      new NextRequest('https://vidak.example/api/videos/public', {
        headers: { Origin: 'https://evil.example' },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [] });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(responseAllowsCredentialedCors(response.headers)).toBe(false);
  });

  it('uses Secure HttpOnly SameSite Lax cookies in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const options = w3dsCookieOptions(900);
    expect(options).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 900,
    });
  });

  it('keeps development cookies non-Secure while remaining HttpOnly SameSite Lax', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const options = w3dsCookieOptions(900);
    expect(options).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 900,
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
