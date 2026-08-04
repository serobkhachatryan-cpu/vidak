export type {
  AuthApi,
  AuthClient,
  AuthProviderCapabilities,
  AuthProviderId,
  AuthSession,
  AuthTokens,
  AuthUser,
  AuthUserPermissions,
  AuthUserProfile,
  LoginChallenge,
  LoginChallengeStatus,
  LoginInput,
  RegisterInput,
  Role,
  StoredAuthSession,
  TokenStorage,
  UpdateAuthProfileInput,
} from './types';

import type { AuthUser, Role, StoredAuthSession, TokenStorage } from './types';

export type AuthenticationErrorCode =
  | 'invalid_credentials'
  | 'email_in_use'
  | 'invalid_session'
  | 'invalid_password'
  | 'weak_password'
  | 'confirmation_mismatch'
  | 'validation_failed'
  | 'unsupported_capability'
  | 'provider_unavailable';

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly code: AuthenticationErrorCode,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
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

export type { CreateAuthUserInput } from './provider';
export {
  authProviderCapabilities,
  capabilitiesFromRoles,
  createAuthUser,
  createSyntheticEName,
  createSyntheticEVaultId,
  getAuthProviderCapabilities,
  parseAuthProviderId,
  permissionsFromRoles,
  readAuthProviderEnv,
  resolveAuthProviderId,
} from './provider';

export {
  persistAuthSession,
  restoreStoredSession,
  shouldPersistAuthSessionToBrowserStorage,
  storeSession,
  toBrowserAuthSession,
} from './session';
