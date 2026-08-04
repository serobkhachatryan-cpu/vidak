export type Role = 'creator' | 'moderator' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  roles: readonly Role[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface AuthSession {
  user: AuthUser;
  tokens: AuthTokens;
}

export interface StoredAuthSession extends AuthSession {
  remember: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
  remember: boolean;
}

export interface RegisterInput extends LoginInput {
  displayName: string;
}

export interface AuthApi {
  login(input: LoginInput): Promise<AuthSession>;
  register(input: RegisterInput): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  getCurrentUser(accessToken: string): Promise<AuthUser>;
  logout(refreshToken?: string): Promise<void>;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_credentials' | 'email_in_use' | 'invalid_session',
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export interface TokenStorage {
  read(): StoredAuthSession | undefined;
  write(session: StoredAuthSession): void;
  clear(): void;
}

export function createMemoryTokenStorage(): TokenStorage {
  let session: StoredAuthSession | undefined;
  return {
    read: () => session,
    write: (next) => {
      session = next;
    },
    clear: () => {
      session = undefined;
    },
  };
}

const storageKey = 'w3ds-auth-session';

function parseSession(value: string | null): StoredAuthSession | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as StoredAuthSession;
  } catch {
    return undefined;
  }
}

export function createBrowserTokenStorage(): TokenStorage {
  const fallback = createMemoryTokenStorage();
  const canUseStorage = () => typeof window !== 'undefined';
  const readFrom = (storage: Storage) => parseSession(storage.getItem(storageKey));

  return {
    read: () => {
      if (!canUseStorage()) return fallback.read();
      const persistent = readFrom(window.localStorage);
      return persistent ?? readFrom(window.sessionStorage);
    },
    write: (session) => {
      if (!canUseStorage()) {
        fallback.write(session);
        return;
      }
      const target = session.remember ? window.localStorage : window.sessionStorage;
      const other = session.remember ? window.sessionStorage : window.localStorage;
      other.removeItem(storageKey);
      target.setItem(storageKey, JSON.stringify(session));
    },
    clear: () => {
      fallback.clear();
      if (!canUseStorage()) return;
      window.localStorage.removeItem(storageKey);
      window.sessionStorage.removeItem(storageKey);
    },
  };
}

export const hasRole = (user: AuthUser | undefined, role: Role) =>
  user?.roles.includes(role) ?? false;

export const hasAnyRole = (user: AuthUser | undefined, roles: readonly Role[]) =>
  roles.some((role) => hasRole(user, role));

export { restoreStoredSession, storeSession } from './session';
