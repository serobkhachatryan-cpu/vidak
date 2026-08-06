import { createAuthUser, toBrowserAuthSession } from '@w3ds/auth';
import { describe, expect, it, vi } from 'vitest';
import { W3dsAuthClient } from './w3ds-auth-client';

const browserSession = toBrowserAuthSession({
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

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

describe('W3dsAuthClient eID session handoff', () => {
  it('restores the authenticated session after cookie-producing offer completion', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/offer/offer-1/status')) {
        return jsonResponse({ status: 'completed', session: browserSession }, 200, {
          'Set-Cookie': 'w3ds_access=access-jwt-must-not-leak; Path=/; HttpOnly; SameSite=Lax',
        });
      }
      if (url.endsWith('/api/auth/session')) {
        return jsonResponse(browserSession);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new W3dsAuthClient({ fetch: fetchMock as typeof fetch });
    await expect(client.getLoginChallengeStatus('offer-1')).resolves.toMatchObject({
      status: 'completed',
      session: browserSession,
    });
    await expect(client.restoreSession()).resolves.toEqual(browserSession);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ cache: 'no-store', credentials: 'include' }),
    );
  });
});
