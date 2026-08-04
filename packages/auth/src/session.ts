import type { AuthApi, AuthSession, StoredAuthSession, TokenStorage } from './index';

type SessionRefreshApi = Pick<AuthApi, 'refresh'>;

export async function restoreStoredSession(
  authApi: SessionRefreshApi,
  tokenStorage: TokenStorage,
): Promise<AuthSession | null> {
  const storedSession = tokenStorage.read();
  if (!storedSession) return null;

  try {
    const refreshedSession = await authApi.refresh(storedSession.tokens.refreshToken);
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
