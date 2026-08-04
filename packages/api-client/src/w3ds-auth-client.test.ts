import { AuthenticationError, createAuthUser, toBrowserAuthSession } from '@w3ds/auth';
import { describe, expect, it, vi } from 'vitest';
import { W3dsAuthClient } from './w3ds-auth-client';

const session = toBrowserAuthSession({
  user: createAuthUser({
    id: 'user-1',
    displayName: 'Ada',
    roles: ['creator'] as const,
    eName: '@ada.w3id',
    eVaultId: 'evault-1',
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

describe('W3dsAuthClient', () => {
  it('exposes W3DS capabilities and rejects password-based operations', async () => {
    const client = new W3dsAuthClient();
    expect(client.provider).toBe('w3ds');
    expect(client.capabilities).toMatchObject({
      emailPasswordLogin: false,
      passwordRegistration: false,
      w3dsAuthChallenge: true,
      changePassword: false,
      changeEmail: false,
    });

    await expect(
      client.login({ email: 'a@b.c', password: 'password123', remember: false }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(
      client.register({
        email: 'a@b.c',
        password: 'password123',
        displayName: 'A',
        remember: false,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
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
  });

  it('creates login challenges and polls offer status through same-origin routes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/offer')) {
        return jsonResponse({
          offerId: 'offer-1',
          uri: 'w3ds://auth?session=abc&platform=vidak',
          sessionId: 'session-1',
          expiresAt: '2026-08-04T12:05:00.000Z',
        });
      }
      if (url.includes('/api/auth/offer/offer-1/status')) {
        return jsonResponse({ status: 'completed', session });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    await expect(client.createLoginChallenge()).resolves.toEqual({
      offerId: 'offer-1',
      signInUri: 'w3ds://auth?session=abc&platform=vidak',
      expiresAt: '2026-08-04T12:05:00.000Z',
    });
    await expect(client.getLoginChallengeStatus('offer-1')).resolves.toEqual({
      status: 'completed',
      session,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/offer',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('restores cookie sessions via /api/auth/session with credentials included', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/session')) return jsonResponse(session);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    await expect(client.restoreSession()).resolves.toEqual(session);
    expect(session.tokens.accessToken).toBeUndefined();
    expect(session.tokens.refreshToken).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/refresh'),
      expect.anything(),
    );
  });

  it('refreshes once and retries the original request after a 401', async () => {
    let sessionCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/session')) {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          return jsonResponse(
            { error: { code: 'invalid_session', message: 'Authentication is required.' } },
            401,
          );
        }
        return jsonResponse(session);
      }
      if (url.endsWith('/api/auth/refresh') && init?.method === 'POST') {
        refreshCalls += 1;
        return jsonResponse(session);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    await expect(client.restoreSession()).resolves.toEqual(session);
    expect(refreshCalls).toBe(1);
    expect(sessionCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('returns null (anonymous) when cookie restore refresh fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/session') || url.endsWith('/api/auth/refresh')) {
        return jsonResponse({ error: { code: 'invalid_session', message: 'gone' } }, 401);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    await expect(client.restoreSession()).resolves.toBeNull();
  });

  it('shares one refresh across concurrent 401s (single-flight)', async () => {
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
        return jsonResponse(session.user);
      }
      if (url.endsWith('/api/auth/refresh') && init?.method === 'POST') {
        refreshCalls += 1;
        await Promise.resolve();
        refreshed = true;
        return jsonResponse(session);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    const [first, second] = await Promise.all([
      client.getCurrentUser('ignored'),
      client.getCurrentUser('ignored'),
    ]);

    expect(first).toEqual(session.user);
    expect(second).toEqual(session.user);
    expect(refreshCalls).toBe(1);
    expect(meCalls).toBe(4);
  });

  it('retries once after 401 then signs out when refresh fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me') || url.endsWith('/api/auth/refresh')) {
        return jsonResponse({ error: { code: 'invalid_session', message: 'gone' } }, 401);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    await expect(client.getCurrentUser('ignored')).rejects.toMatchObject({
      code: 'invalid_session',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    // Original + refresh attempt only — no infinite retry loop.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/me')),
    ).toHaveLength(1);
  });

  it('logs out through the platform logout route', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    await expect(client.logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('maps transport failures to AuthenticationError', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'provider_unavailable', message: 'down' } }, 503),
    );
    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    await expect(client.createLoginChallenge()).rejects.toBeInstanceOf(AuthenticationError);
  });
});
