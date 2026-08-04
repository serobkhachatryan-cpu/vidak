import {
  type AuthClient,
  AuthenticationError,
  authProviderCapabilities,
  createAuthUser,
  toBrowserAuthSession,
} from '@w3ds/auth';
import { describe, expect, it, vi } from 'vitest';
import { MockAuthApiClient } from './mock-auth-client';
import { W3dsAuthClient } from './w3ds-auth-client';

/**
 * Capability-aware AuthClient contract suite.
 * Each provider runs only the assertions that match its capability matrix —
 * W3DS is never forced to emulate password behavior.
 */
function runAuthClientContract(
  label: string,
  createClient: () => AuthClient,
  extras?: {
    /** Optional factory that returns a W3DS client with cookie/session fetch stubs. */
    createW3dsWithSession?: () => AuthClient;
  },
) {
  describe(`AuthClient contract: ${label}`, () => {
    it('exposes the provider capability matrix as the single source of truth', () => {
      const client = createClient();
      expect(client.capabilities).toEqual(authProviderCapabilities[client.provider]);
    });

    it('supports or rejects email/password login according to capabilities', async () => {
      const client = createClient();
      if (client.capabilities.emailPasswordLogin) {
        const session = await client.login({
          email: 'demo@w3ds.video',
          password: 'password123',
          remember: true,
        });
        expect(session.provider).toBe(client.provider);
        expect(session.user.email).toBe('demo@w3ds.video');
        expect(session.tokens.accessToken).toEqual(expect.any(String));
        expect(session.tokens.refreshToken).toEqual(expect.any(String));
        expect(session.tokens.expiresAt).toEqual(expect.any(String));
      } else {
        await expect(
          client.login({ email: 'a@b.c', password: 'password123', remember: false }),
        ).rejects.toMatchObject({ code: 'unsupported_capability' });
      }
    });

    it('supports or rejects password registration according to capabilities', async () => {
      const client = createClient();
      if (client.capabilities.passwordRegistration) {
        const session = await client.register({
          displayName: 'Contract User',
          email: `contract-${client.provider}@example.com`,
          password: 'password123',
          remember: false,
        });
        expect(session.user.displayName).toBe('Contract User');
        expect(session.provider).toBe(client.provider);
      } else {
        await expect(
          client.register({
            displayName: 'Nope',
            email: 'nope@example.com',
            password: 'password123',
            remember: false,
          }),
        ).rejects.toMatchObject({ code: 'unsupported_capability' });
      }
    });

    it('supports or rejects password and email account changes according to capabilities', async () => {
      const client = createClient();

      if (client.capabilities.changePassword || client.capabilities.changeEmail) {
        const session = await client.login({
          email: 'demo@w3ds.video',
          password: 'password123',
          remember: true,
        });
        const accessToken = session.tokens.accessToken as string;

        if (client.capabilities.changeEmail) {
          const updated = await client.changeEmail(accessToken, {
            email: 'demo-contract@w3ds.video',
            password: 'password123',
          });
          expect(updated.email).toBe('demo-contract@w3ds.video');
        }

        if (client.capabilities.changePassword) {
          await expect(
            client.changePassword(accessToken, {
              currentPassword: 'password123',
              newPassword: 'password456',
            }),
          ).resolves.toBeUndefined();
        }
      } else {
        await expect(
          client.changePassword('access', {
            currentPassword: 'old',
            newPassword: 'newpassword',
          }),
        ).rejects.toMatchObject({ code: 'unsupported_capability' });
        await expect(
          client.changeEmail('access', {
            email: 'new@example.com',
            password: 'password123',
          }),
        ).rejects.toMatchObject({ code: 'unsupported_capability' });
      }
    });

    it('supports or rejects account deletion according to capabilities', async () => {
      const client = createClient();
      if (client.capabilities.deleteAccount) {
        const session = await client.register({
          displayName: 'Delete Me',
          email: `delete-${Date.now()}@example.com`,
          password: 'password123',
          remember: false,
        });
        const accessToken = session.tokens.accessToken as string;
        await expect(
          client.deleteAccount(accessToken, {
            password: 'password123',
            confirmation: 'DELETE',
          }),
        ).resolves.toBeUndefined();
      } else {
        await expect(
          client.deleteAccount('access', {
            password: 'password123',
            confirmation: 'DELETE',
          }),
        ).rejects.toMatchObject({ code: 'unsupported_capability' });
      }
    });

    it('supports or rejects W3DS login challenges according to capabilities', async () => {
      const client = createClient();
      if (!client.capabilities.w3dsAuthChallenge) {
        await expect(client.createLoginChallenge()).rejects.toMatchObject({
          code: 'unsupported_capability',
        });
        await expect(client.getLoginChallengeStatus('offer-1')).rejects.toMatchObject({
          code: 'unsupported_capability',
        });
        await expect(client.restoreSession()).resolves.toBeNull();
        return;
      }

      const sessionClient = extras?.createW3dsWithSession?.() ?? client;
      const challenge = await sessionClient.createLoginChallenge();
      expect(challenge).toMatchObject({
        offerId: expect.any(String),
        signInUri: expect.any(String),
        expiresAt: expect.any(String),
      });
      const status = await sessionClient.getLoginChallengeStatus(challenge.offerId);
      expect(status.status).toBe('completed');
      if (status.status === 'completed') {
        expect(status.session.provider).toBe('w3ds');
        expect(status.session.tokens.refreshToken).toBeUndefined();
        expect(status.session.tokens.accessToken).toBeUndefined();
      }
    });

    it('preserves Phase 5 session guarantees for cookie-based providers', async () => {
      const client = createClient();
      if (!client.capabilities.w3dsAuthChallenge) {
        // Development provider keeps refresh tokens in AuthSession for browser storage.
        const session = await client.login({
          email: 'demo@w3ds.video',
          password: 'password123',
          remember: true,
        });
        expect(session.tokens.refreshToken).toEqual(expect.any(String));
        return;
      }

      const sessionClient = extras?.createW3dsWithSession?.() ?? client;
      const restored = await sessionClient.restoreSession();
      expect(restored).not.toBeNull();
      expect(restored?.tokens.refreshToken).toBeUndefined();
      expect(restored?.tokens.accessToken).toBeUndefined();
      expect(JSON.stringify(restored)).not.toMatch(/refreshToken|accessToken/);
    });
  });
}

const browserW3dsSession = toBrowserAuthSession({
  user: createAuthUser({
    id: 'user-contract',
    displayName: 'Contract',
    roles: ['creator'] as const,
    eName: '@contract.w3id',
    eVaultId: 'evault-contract',
  }),
  tokens: {
    accessToken: 'access-jwt-must-not-leak',
    refreshToken: 'refresh-jwt-must-not-leak',
    expiresAt: '2026-08-04T12:20:00.000Z',
  },
  provider: 'w3ds',
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createW3dsContractClient(): W3dsAuthClient {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/offer')) {
      return jsonResponse({
        offerId: 'offer-contract',
        uri: 'w3ds://auth?session=contract&platform=vidak',
        sessionId: 'session-contract',
        expiresAt: '2026-08-04T12:05:00.000Z',
      });
    }
    if (url.includes('/api/auth/offer/offer-contract/status')) {
      return jsonResponse({ status: 'completed', session: browserW3dsSession });
    }
    if (url.endsWith('/api/auth/session')) {
      return jsonResponse(browserW3dsSession);
    }
    if (url.endsWith('/api/auth/refresh') && init?.method === 'POST') {
      return jsonResponse(browserW3dsSession);
    }
    if (url.endsWith('/api/auth/logout') && init?.method === 'POST') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch in W3DS contract client: ${url}`);
  });

  return new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
}

runAuthClientContract('development', () => new MockAuthApiClient());
runAuthClientContract('w3ds', () => new W3dsAuthClient(), {
  createW3dsWithSession: createW3dsContractClient,
});

describe('AuthClient contract: W3DS cookie session path', () => {
  it('restores cookie sessions without refresh tokens in the serialized payload', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/session')) return jsonResponse(browserW3dsSession);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    const session = await client.restoreSession();
    expect(session).toEqual(browserW3dsSession);
    expect(session?.tokens.refreshToken).toBeUndefined();
    expect(session?.tokens.accessToken).toBeUndefined();
    expect(JSON.stringify(session)).not.toMatch(/refreshToken|accessToken/);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('shares one in-flight refresh across concurrent 401 recoveries', async () => {
    let refreshCalls = 0;
    let meCalls = 0;
    let refreshed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        meCalls += 1;
        if (!refreshed) {
          return jsonResponse({ error: { code: 'invalid_session', message: 'expired' } }, 401);
        }
        return jsonResponse(browserW3dsSession.user);
      }
      if (url.endsWith('/api/auth/refresh') && init?.method === 'POST') {
        refreshCalls += 1;
        await Promise.resolve();
        refreshed = true;
        return jsonResponse(browserW3dsSession);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    const [first, second] = await Promise.all([
      client.getCurrentUser('ignored'),
      client.getCurrentUser('ignored'),
    ]);

    expect(first).toEqual(browserW3dsSession.user);
    expect(second).toEqual(browserW3dsSession.user);
    expect(refreshCalls).toBe(1);
    expect(meCalls).toBe(4);
  });

  it('maps unsupported password operations to AuthenticationError unsupported_capability', async () => {
    const client = new W3dsAuthClient();
    const operations = [
      () => client.login({ email: 'a@b.c', password: 'password123', remember: false }),
      () =>
        client.register({
          email: 'a@b.c',
          password: 'password123',
          displayName: 'A',
          remember: false,
        }),
      () => client.changePassword('access', { currentPassword: 'a', newPassword: 'abcdefgh' }),
      () => client.changeEmail('access', { email: 'b@c.d', password: 'password123' }),
      () => client.deleteAccount('access', { password: 'password123', confirmation: 'DELETE' }),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(AuthenticationError);
      await expect(operation()).rejects.toMatchObject({ code: 'unsupported_capability' });
    }
  });
});
