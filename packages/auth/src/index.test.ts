import { describe, expect, it } from 'vitest';
import { createMemoryTokenStorage, hasAnyRole, hasRole, type StoredAuthSession } from './index';

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
});
