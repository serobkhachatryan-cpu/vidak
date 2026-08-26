import { createAuthUser } from '@w3ds/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryW3dsAuthStore,
  RegistryW3dsIdentityVerifier,
  readW3dsAuthConfig,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthError,
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
    verify: vi.fn().mockImplementation(async ({ eName }: { eName: string }) => {
      if (eName === verifiedIdentity.eName) return verifiedIdentity;
      const slug = eName.slice(1).replace(/\.w3id$/i, '') || 'user';
      return {
        eName,
        eVaultId: `evault-${slug}`,
        eVaultUri: `https://evault.example/${slug}`,
      };
    }),
  };
  const clock = { value: now };
  const store = new InMemoryW3dsAuthStore();
  return {
    verifier,
    clock,
    store,
    service: new W3dsAuthService({
      config: {
        platformName: 'vidak',
        registryBaseUrl: 'https://registry.example',
        jwtSecret: 'a development-only test secret with at least 32 characters',
      },
      store,
      identityVerifier: verifier,
      now: () => clock.value,
    }),
  };
}

describe('W3dsAuthService', () => {
  afterEach(() => {
    resetW3dsAuthServiceForTests();
    vi.unstubAllEnvs();
  });

  it('completes a one-time signed offer and creates a reusable platform user', async () => {
    const { service, verifier, store } = createService();
    const offer = await service.createOffer('https://vidak.example');
    const uri = new URL(offer.uri);

    expect(uri.protocol).toBe('w3ds:');
    expect(uri.searchParams.get('platform')).toBe('vidak');
    expect(uri.searchParams.get('redirect')).toBe('https://vidak.example/api/auth');
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

    const reused = await store.findOrCreateUser(
      createAuthUser({
        id: 'w3ds_different',
        displayName: 'Other',
        roles: ['creator'],
        eName: '@creator.w3id',
        eVaultId: 'evault-creator',
        eVaultUri: 'https://evault.example/creator',
      }),
    );
    expect(reused.id).toBe(status.session.user.id);
    expect(reused.eName).toBe('@creator.w3id');
  });

  it('reuses the server-side verifier for arbitrary signed payloads without issuing a login session', async () => {
    const { service, verifier, store } = createService();

    await expect(
      service.verifySignedPayload({
        w3id: verifiedIdentity.eName,
        payload: 'signing-session-1',
        signature: 'signature',
      }),
    ).resolves.toEqual(verifiedIdentity);
    expect(verifier.verify).toHaveBeenCalledWith({
      eName: verifiedIdentity.eName,
      session: 'signing-session-1',
      signature: 'signature',
    });
    await expect(store.getOfferBySessionId('signing-session-1')).resolves.toBeUndefined();
  });

  it('reconstructs a pending offer for a server-rendered login page', async () => {
    const { service } = createService();
    const created = await service.createOffer('https://vidak.example');

    await expect(
      service.getOfferForLogin(created.offerId, 'https://vidak.example'),
    ).resolves.toEqual(created);
    await expect(
      service.getOfferForLogin('missing', 'https://vidak.example'),
    ).resolves.toBeUndefined();
  });

  it('finds or creates platform users uniquely by eName', async () => {
    const store = new InMemoryW3dsAuthStore();
    const first = await store.findOrCreateUser(
      createAuthUser({
        id: 'w3ds_a',
        displayName: 'Creator',
        roles: ['creator'],
        eName: '@creator.w3id',
        eVaultId: 'evault-creator',
      }),
    );
    const second = await store.findOrCreateUser(
      createAuthUser({
        id: 'w3ds_b',
        displayName: 'Other',
        roles: ['creator'],
        eName: '@creator.w3id',
        eVaultId: 'evault-other',
      }),
    );
    const other = await store.findOrCreateUser(
      createAuthUser({
        id: 'w3ds_c',
        displayName: 'Viewer',
        roles: ['creator'],
        eName: '@viewer.w3id',
        eVaultId: 'evault-viewer',
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.eVaultId).toBe('evault-creator');
    expect(other.id).toBe('w3ds_c');
    await expect(store.findUserByEName('@missing.w3id')).resolves.toBeUndefined();
  });

  it('consumes an offer only once under concurrent callback attempts', async () => {
    const { service, verifier } = createService();
    const offer = await service.createOffer('https://vidak.example');

    const results = await Promise.allSettled([
      service.completeOffer({
        w3id: '@creator.w3id',
        session: offer.sessionId,
        signature: 'signature-a',
      }),
      service.completeOffer({
        w3id: '@creator.w3id',
        session: offer.sessionId,
        signature: 'signature-b',
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'consumed_session',
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    await expect(service.getOfferStatus(offer.offerId)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('rotates refresh tokens and invalidates the old access token', async () => {
    const { service } = createService();
    const offer = await service.createOffer('https://vidak.example');
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

  it('revokes sessions on logout across subsequent credential use', async () => {
    const { service } = createService();
    const offer = await service.createOffer('https://vidak.example');
    await service.completeOffer({
      w3id: '@creator.w3id',
      session: offer.sessionId,
      signature: 'signature',
    });
    const cookieSession = await service.getOfferSessionForCookie(offer.offerId);
    const accessToken = cookieSession.tokens.accessToken;
    const refreshToken = cookieSession.tokens.refreshToken;
    if (!accessToken || !refreshToken) throw new Error('Expected cookie credentials.');

    await service.logout(accessToken, refreshToken);
    await expect(service.getSession(accessToken)).rejects.toMatchObject({
      code: 'invalid_session',
    });
    await expect(service.refreshSession(refreshToken)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('expires offers after five minutes without accepting a callback', async () => {
    const { service, clock } = createService();
    const offer = await service.createOffer('https://vidak.example');
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

  it('expires refresh sessions when the refresh lifetime elapses', async () => {
    const { service, clock } = createService();
    const offer = await service.createOffer('https://vidak.example');
    await service.completeOffer({
      w3id: '@creator.w3id',
      session: offer.sessionId,
      signature: 'signature',
    });
    const cookieSession = await service.getOfferSessionForCookie(offer.offerId);
    const refreshToken = cookieSession.tokens.refreshToken;
    if (!refreshToken) throw new Error('Expected a refresh token.');

    clock.value += 7 * 24 * 60 * 60 * 1000 + 1;
    await expect(service.refreshSession(refreshToken)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('fails W3DS configuration when DATABASE_URL is missing', () => {
    vi.stubEnv('W3DS_REGISTRY_BASE_URL', 'https://registry.example');
    vi.stubEnv(
      'W3DS_AUTH_JWT_SECRET',
      'a development-only test secret with at least 32 characters',
    );
    vi.stubEnv('DATABASE_URL', '');

    expect(() => readW3dsAuthConfig()).toThrow(W3dsAuthError);
    try {
      readW3dsAuthConfig();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'configuration_error',
        status: 503,
        message: expect.stringContaining('DATABASE_URL'),
      });
    }
  });

  it('keeps development-provider configuration independent of DATABASE_URL', async () => {
    // Development auth lives in MockAuthApiClient and never calls getW3dsAuthService.
    const { createAuthClient } = await import('@w3ds/api-client');
    vi.stubEnv('DATABASE_URL', '');
    const client = createAuthClient({ provider: 'dev' });
    expect(client.provider).toBe('dev');
    expect(client.capabilities.emailPasswordLogin).toBe(true);
    expect(client.capabilities.w3dsAuthChallenge).toBe(false);

    const session = await client.login({
      email: 'demo@w3ds.video',
      password: 'password123',
      remember: true,
    });
    expect(session.provider).toBe('dev');
    expect(session.tokens.accessToken).toEqual(expect.any(String));
  });

  it('updates the authenticated user profile and rejects anonymous callers', async () => {
    const { service } = createService();
    const accessToken = await completeLogin(service, '@creator.w3id');

    const updated = await service.updateProfile(accessToken, {
      displayName: 'Creator Updated',
      avatarUrl: 'https://cdn.example/avatar.png',
    });
    expect(updated).toMatchObject({
      displayName: 'Creator Updated',
      profile: {
        displayName: 'Creator Updated',
        avatarUrl: 'https://cdn.example/avatar.png',
      },
      eName: '@creator.w3id',
    });
    await expect(service.getSession(accessToken)).resolves.toMatchObject({
      user: {
        displayName: 'Creator Updated',
        profile: { avatarUrl: 'https://cdn.example/avatar.png' },
      },
    });

    await expect(
      service.updateProfile('not-a-token', { displayName: 'Nope' }),
    ).rejects.toMatchObject({
      code: 'invalid_session',
      status: 401,
    });
    await expect(service.updateProfile(accessToken, { displayName: '   ' })).rejects.toMatchObject({
      code: 'validation_failed',
      status: 400,
    });
  });

  it('lists only the caller sessions and rejects foreign or current revocation', async () => {
    const { service, store } = createService();
    const creatorAccess = await completeLogin(service, '@creator.w3id');
    const creatorSecondAccess = await completeLogin(service, '@creator.w3id');
    const viewerAccess = await completeLogin(service, '@viewer.w3id');

    const creatorSessions = await service.listSessions(creatorSecondAccess);
    expect(creatorSessions).toHaveLength(2);
    expect(creatorSessions.every((session) => typeof session.id === 'string')).toBe(true);
    expect(creatorSessions.filter((session) => session.current)).toHaveLength(1);
    expect(JSON.stringify(creatorSessions)).not.toMatch(/refreshJti|accessJti|refreshToken/);

    const creatorCurrent = creatorSessions.find((session) => session.current);
    const creatorOther = creatorSessions.find((session) => !session.current);
    if (!creatorCurrent || !creatorOther) throw new Error('Expected current and other sessions.');

    await expect(
      service.revokeUserSession(creatorSecondAccess, creatorCurrent.id),
    ).rejects.toMatchObject({
      code: 'invalid_session',
      message: 'You cannot revoke your current session.',
      status: 400,
    });

    const viewerSessions = await service.listSessions(viewerAccess);
    expect(viewerSessions).toHaveLength(1);
    await expect(service.revokeUserSession(viewerAccess, creatorOther.id)).rejects.toMatchObject({
      code: 'invalid_session',
      status: 404,
    });
    await expect(service.listSessions(viewerAccess)).resolves.toHaveLength(1);
    expect(await store.getSessionById(creatorOther.id)).toMatchObject({ revoked: false });

    await expect(service.revokeUserSession(creatorSecondAccess, creatorOther.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: creatorCurrent.id, current: true })]),
    );
    expect(await store.getSessionById(creatorOther.id)).toMatchObject({ revoked: true });
    await expect(service.getSession(creatorAccess)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('preserves development-provider account settings behavior', async () => {
    const { createAuthClient } = await import('@w3ds/api-client');
    const client = createAuthClient({ provider: 'dev' });
    const session = await client.login({
      email: 'demo@w3ds.video',
      password: 'password123',
      remember: true,
    });
    const accessToken = session.tokens.accessToken as string;

    const updated = await client.updateProfile(accessToken, { displayName: 'Demo Settings' });
    expect(updated.displayName).toBe('Demo Settings');
    const sessions = await client.listSessions(accessToken);
    expect(sessions.some((item) => item.current)).toBe(true);
    await expect(
      client.changeEmail(accessToken, {
        email: 'demo-settings@w3ds.video',
        password: 'password123',
      }),
    ).resolves.toMatchObject({ email: 'demo-settings@w3ds.video' });
    expect(client.capabilities).toMatchObject({
      changeEmail: true,
      changePassword: true,
      deleteAccount: true,
      manageSessions: true,
    });
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
        // The eID software wallet emits a `z` prefix followed by hexadecimal
        // SPKI bytes, not standard base58 multibase content.
        publicKey: `z${Buffer.from(userSpki).toString('hex')}`,
        iat: now,
        exp: now + 60 * 60,
      },
    );
    const rawHexCertificate = await signJsonWebToken(
      registryKeyPair.privateKey,
      { alg: 'ES256', kid: 'registry-key' },
      {
        ename: '@creator.w3id',
        // The hardware eID Wallet may publish the same SPKI as raw 0x hex.
        publicKey: `0x${Buffer.from(userSpki).toString('hex')}`,
        iat: now,
        exp: now + 60 * 60,
      },
    );
    let useRawHexPublicKey = false;
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
        return Response.json({
          keyBindingCertificates: [useRawHexPublicKey ? rawHexCertificate : certificate],
        });
      }
      if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [registryJwk] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const verifier = new RegistryW3dsIdentityVerifier('https://registry.example');
      await expect(
        verifier.verify({
          eName: '@creator.w3id',
          session,
          signature: Buffer.from(signature).toString('base64'),
        }),
      ).resolves.toEqual(verifiedIdentity);
      await expect(
        verifier.verify({
          eName: '@creator.w3id',
          session,
          signature: Buffer.from(rawEcdsaToDer(new Uint8Array(signature))).toString('base64'),
        }),
      ).resolves.toEqual(verifiedIdentity);
      await expect(
        verifier.verify({
          eName: '@creator.w3id',
          session,
          signature: `z${base58Encode(new Uint8Array(signature))}`,
        }),
      ).resolves.toEqual(verifiedIdentity);
      useRawHexPublicKey = true;
      await expect(
        verifier.verify({
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

async function completeLogin(service: W3dsAuthService, eName: string): Promise<string> {
  const offer = await service.createOffer('https://vidak.example');
  await service.completeOffer({
    w3id: eName,
    session: offer.sessionId,
    signature: 'signature',
  });
  const cookieSession = await service.getOfferSessionForCookie(offer.offerId);
  const accessToken = cookieSession.tokens.accessToken;
  if (!accessToken) throw new Error('Expected an access token.');
  return accessToken;
}

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

function base58Encode(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }

  let encoded = '';
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function rawEcdsaToDer(signature: Uint8Array): Uint8Array {
  const scalarLength = signature.length / 2;
  if (!Number.isInteger(scalarLength)) throw new Error('Expected an ECDSA r || s signature.');
  const encodeInteger = (value: Uint8Array) => {
    let firstSignificant = 0;
    while (firstSignificant < value.length - 1 && value[firstSignificant] === 0) {
      firstSignificant += 1;
    }
    const normalized = value.slice(firstSignificant);
    const needsPadding = (normalized[0] ?? 0) >= 0x80;
    const output = new Uint8Array(normalized.length + (needsPadding ? 1 : 0));
    output.set(normalized, needsPadding ? 1 : 0);
    return output;
  };
  const r = encodeInteger(signature.slice(0, scalarLength));
  const s = encodeInteger(signature.slice(scalarLength));
  const body = new Uint8Array(4 + r.length + s.length);
  body.set([0x02, r.length], 0);
  body.set(r, 2);
  body.set([0x02, s.length], 2 + r.length);
  body.set(s, 4 + r.length);
  const der = new Uint8Array(2 + body.length);
  der.set([0x30, body.length], 0);
  der.set(body, 2);
  return der;
}
