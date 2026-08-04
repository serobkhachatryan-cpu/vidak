import type { AuthApi, AuthSession, StoredAuthSession, TokenStorage } from './types';

type SessionRefreshApi = Pick<AuthApi, 'refresh'>;

export async function restoreStoredSession(
  authApi: SessionRefreshApi,
  tokenStorage: TokenStorage,
): Promise<AuthSession | null> {
  const storedSession = tokenStorage.read();
  if (!storedSession) return null;

  const refreshToken = storedSession.tokens.refreshToken;
  if (!refreshToken) {
    tokenStorage.clear();
    return null;
  }

  try {
    const refreshedSession = await authApi.refresh(refreshToken);
    tokenStorage.write({ ...refreshedSession, remember: storedSession.remember });
    return refreshedSession;
  } catch {
    tokenStorage.clear();
    return null;
  }
}

export function storeSession(
  tokenStorage: TokenStorage,
  session: AuthSession,
  remember: boolean,
): StoredAuthSession {
  const storedSession = { ...session, remember };
  tokenStorage.write(storedSession);
  return storedSession;
}

/**
 * Browser-safe W3DS session projection: user + expiry only.
 * Access/refresh JWTs stay in HttpOnly cookies and must never be serialized to JS.
 */
export function toBrowserAuthSession(session: AuthSession): AuthSession {
  return {
    user: session.user,
    provider: session.provider,
    tokens: {
      expiresAt: session.tokens.expiresAt,
    },
  };
}

/** Development provider persists tokens in browser storage; W3DS uses cookies only. */
export function shouldPersistAuthSessionToBrowserStorage(session: AuthSession): boolean {
  return session.provider !== 'w3ds';
}

/**
 * Persists a session for the development provider only.
 * W3DS sessions are ignored so refresh tokens never touch localStorage/sessionStorage.
 */
export function persistAuthSession(
  tokenStorage: TokenStorage,
  session: AuthSession,
  remember: boolean,
): AuthSession {
  if (!shouldPersistAuthSessionToBrowserStorage(session)) return toBrowserAuthSession(session);
  storeSession(tokenStorage, session, remember);
  return session;
}
