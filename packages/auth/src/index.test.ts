import { describe, expect, it } from 'vitest';
import {
  type AuthSession,
  capabilitiesFromRoles,
  createAuthUser,
  createMemoryTokenStorage,
  createSyntheticEName,
  getAuthProviderCapabilities,
  hasAnyRole,
  hasRole,
  parseAuthProviderId,
  permissionsFromRoles,
  restoreStoredSession,
  type StoredAuthSession,
  storeSession,
} from './index';

const session: StoredAuthSession = {
  user: createAuthUser({
    id: 'user-1',
    email: 'creator@example.com',
    displayName: 'Creator',
    roles: ['creator'],
    eName: '@creator.w3id',
    eVaultId: 'evault-user-1',
  }),
  tokens: {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: '2026-01-01T00:00:00.000Z',
  },
  provider: 'dev',
  remember: true,
};

describe('authentication utilities', () => {
  it('stores and clears a session through the token storage abstraction', () => {
    const storage = createMemoryTokenStorage();
    expect(storage.read()).toBeUndefined();
    storage.write(session);
    expect(storage.read()).toEqual(session);
    storage.clear();
    expect(storage.read()).toBeUndefined();
  });

  it('checks individual and grouped user roles', () => {
    expect(hasRole(session.user, 'creator')).toBe(true);
    expect(hasRole(session.user, 'admin')).toBe(false);
    expect(hasAnyRole(session.user, ['admin', 'creator'])).toBe(true);
    expect(hasAnyRole(undefined, ['creator'])).toBe(false);
  });

  it('refreshes a stored session while preserving its persistence preference', async () => {
    const storage = createMemoryTokenStorage();
    storage.write({ ...session, remember: false });
    const refreshedSession: AuthSession = {
      ...session,
      tokens: { ...session.tokens, accessToken: 'access-2' },
    };

    await expect(
      restoreStoredSession({ refresh: async () => refreshedSession }, storage),
    ).resolves.toEqual(refreshedSession);
    expect(storage.read()).toEqual({ ...refreshedSession, remember: false });
  });

  it('clears an invalid stored session and stores new sessions with their preference', async () => {
    const storage = createMemoryTokenStorage();
    storage.write(session);

    await expect(
      restoreStoredSession(
        {
          refresh: async () => {
            throw new Error('session expired');
          },
        },
        storage,
      ),
    ).resolves.toBeNull();
    expect(storage.read()).toBeUndefined();

    expect(storeSession(storage, session, false)).toEqual({ ...session, remember: false });
    expect(storage.read()).toEqual({ ...session, remember: false });
  });

  it('clears stored sessions that lack a refresh token', async () => {
    const storage = createMemoryTokenStorage();
    storage.write({
      ...session,
      tokens: { accessToken: 'access-1', expiresAt: session.tokens.expiresAt },
    });

    await expect(
      restoreStoredSession({ refresh: async () => session }, storage),
    ).resolves.toBeNull();
    expect(storage.read()).toBeUndefined();
  });

  it('parses auth provider ids and exposes provider capabilities', () => {
    expect(parseAuthProviderId(undefined)).toBe('dev');
    expect(parseAuthProviderId('dev')).toBe('dev');
    expect(parseAuthProviderId('w3ds')).toBe('w3ds');
    expect(() => parseAuthProviderId('ldap')).toThrow(/Unsupported auth provider/);

    expect(getAuthProviderCapabilities('dev').emailPasswordLogin).toBe(true);
    expect(getAuthProviderCapabilities('w3ds').w3dsAuthChallenge).toBe(true);
    expect(getAuthProviderCapabilities('w3ds').emailPasswordLogin).toBe(false);
  });

  it('builds platform auth users with synthetic W3DS identity fields', () => {
    const user = createAuthUser({
      id: 'user-demo',
      email: 'demo@w3ds.video',
      displayName: 'Demo Creator',
      roles: ['creator'],
    });

    expect(user.eName).toBe(createSyntheticEName('user-demo'));
    expect(user.eVaultId).toBe('evault-user-demo');
    expect(user.profile.displayName).toBe('Demo Creator');
    expect(user.permissions).toEqual(permissionsFromRoles(['creator']));
    expect(user.capabilities).toEqual(capabilitiesFromRoles(['creator']));
    expect(user.displayName).toBe('Demo Creator');
  });
});
