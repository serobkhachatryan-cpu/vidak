import { describe, expect, it } from 'vitest';
import {
  type AuthSession,
  createMemoryTokenStorage,
  hasAnyRole,
  hasRole,
  restoreStoredSession,
  type StoredAuthSession,
  storeSession,
} from './index';

const session: StoredAuthSession = {
  user: {
    id: 'user-1',
    email: 'creator@example.com',
    displayName: 'Creator',
    roles: ['creator'],
  },
  tokens: {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: '2026-01-01T00:00:00.000Z',
  },
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
});
