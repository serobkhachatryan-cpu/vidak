import { describe, expect, it, vi } from 'vitest';
import {
  RegistryW3dsIdentityVerifier,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsIdentityVerifier,
} from './w3ds-auth';

const verifiedIdentity: VerifiedW3dsIdentity = {
  eName: '@creator.w3id',
  eVaultId: 'evault-creator',
  eVaultUri: 'https://evault.example/creator',
};

function createService(now = 1_780_000_000_000) {
  const verifier: W3dsIdentityVerifier = {
    verify: vi.fn().mockResolvedValue(verifiedIdentity),
  };
  const clock = { value: now };
  return {
    verifier,
    clock,
    service: new W3dsAuthService({
      config: {
        platformName: 'vidak',
        registryBaseUrl: 'https://registry.example',
        jwtSecret: 'a development-only test secret with at least 32 characters',
      },
      identityVerifier: verifier,
      now: () => clock.value,
    }),
  };
}

describe('W3dsAuthService', () => {
  it('completes a one-time signed offer and creates a reusable platform user', async () => {
    const { service, verifier } = createService();
    const offer = service.createOffer('https://vidak.example');
    const uri = new URL(offer.uri);

    expect(uri.protocol).toBe('w3ds:');
    expect(uri.searchParams.get('platform')).toBe('vidak');
    expect(uri.searchParams.get('redirect')).toBe('https://vidak.example/api/auth/callback');
    await expect(service.getOfferStatus(offer.offerId)).resolves.toEqual({ status: 'pending' });

    await service.completeOffer({
      w3id: '@creator.w3id',
      session: offer.sessionId,
      signature: 'signature',
    });
    expect(verifier.verify).toHaveBeenCalledWith({
      eName: '@creator.w3id',
      session: offer.sessionId,
      signature: 'signature',
    });

    const status = await service.getOfferStatus(offer.offerId);
    expect(status.status).toBe('completed');
    if (status.status !== 'completed') throw new Error('Expected a completed offer.');
    expect(status.session).toMatchObject({
      provider: 'w3ds',
      user: verifiedIdentity,
    });
    expect(status.session.tokens.accessToken).toBeUndefined();
    expect(status.session.tokens.refreshToken).toBeUndefined();
    expect(status.session.tokens.expiresAt).toEqual(expect.any(String));

    const cookieSession = await service.getOfferSessionForCookie(offer.offerId);
    expect(cookieSession.tokens.accessToken).toEqual(expect.any(String));
    expect(cookieSession.tokens.refreshToken).toEqual(expect.any(String));
    const accessToken = cookieSession.tokens.accessToken;
    if (!accessToken) throw new Error('Expected an access token for cookies.');
    await expect(service.getSession(accessToken)).resolves.toMatchObject({
      user: verifiedIdentity,
      tokens: { expiresAt: expect.any(String) },
    });
    const publicSession = await service.getSession(accessToken);
    expect(publicSession.tokens.accessToken).toBeUndefined();
    expect(publicSession.tokens.refreshToken).toBeUndefined();

    await expect(
      service.completeOffer({
        w3id: '@creator.w3id',
        session: offer.sessionId,
        signature: 'signature',
      }),
    ).rejects.toMatchObject({ code: 'consumed_session' });
  });

  it('rotates refresh tokens and invalidates the old access token', async () => {
    const { service } = createService();
    const offer = service.createOffer('https://vidak.example');
    await service.completeOffer({
      w3id: '@creator.w3id',
      session: offer.sessionId,
      signature: 'signature',
    });
    const cookieSession = await service.getOfferSessionForCookie(offer.offerId);
    const accessToken = cookieSession.tokens.accessToken;
    const refreshToken = cookieSession.tokens.refreshToken;
    if (!accessToken || !refreshToken) throw new Error('Expected cookie credentials.');

    const refreshed = await service.refreshSession(refreshToken);
    expect(refreshed.tokens.refreshToken).not.toBe(refreshToken);
    expect(refreshed.tokens.accessToken).toEqual(expect.any(String));
    await expect(service.getSession(accessToken)).rejects.toMatchObject({
      code: 'invalid_session',
    });
    await expect(service.refreshSession(refreshToken)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('expires offers after five minutes without accepting a callback', async () => {
    const { service, clock } = createService();
    const offer = service.createOffer('https://vidak.example');
    clock.value += 5 * 60 * 1000;

    await expect(service.getOfferStatus(offer.offerId)).resolves.toEqual({ status: 'expired' });
    await expect(
      service.completeOffer({
        w3id: '@creator.w3id',
        session: offer.sessionId,
        signature: 'signature',
      }),
    ).rejects.toMatchObject({ code: 'expired_session' });
  });

  it('verifies Registry-attested eVault keys before accepting a wallet signature', async () => {
    const registryKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const userKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const registryJwk = {
      ...(await crypto.subtle.exportKey('jwk', registryKeyPair.publicKey)),
      kid: 'registry-key',
    };
    const userSpki = new Uint8Array(await crypto.subtle.exportKey('spki', userKeyPair.publicKey));
    const now = Math.floor(Date.now() / 1000);
    const certificate = await signJsonWebToken(
      registryKeyPair.privateKey,
      { alg: 'ES256', kid: 'registry-key' },
      {
        ename: '@creator.w3id',
        publicKey: `m${Buffer.from(userSpki).toString('base64url')}`,
        iat: now,
        exp: now + 60 * 60,
      },
    );
    const session = 'c2d22408-daa6-4e54-a8ea-a90fc0c5a100';
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      userKeyPair.privateKey,
      new TextEncoder().encode(session),
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname === '/resolve') {
        return Response.json({
          ename: '@creator.w3id',
          evault: 'evault-creator',
          uri: 'https://evault.example/creator',
        });
      }
      if (url.hostname === 'evault.example' && url.pathname === '/whois') {
        return Response.json({ keyBindingCertificates: [certificate] });
      }
      if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [registryJwk] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        new RegistryW3dsIdentityVerifier('https://registry.example').verify({
          eName: '@creator.w3id',
          session,
          signature: Buffer.from(signature).toString('base64'),
        }),
      ).resolves.toEqual(verifiedIdentity);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

async function signJsonWebToken(
  privateKey: CryptoKey,
  header: Record<string, string>,
  payload: Record<string, string | number>,
): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}
