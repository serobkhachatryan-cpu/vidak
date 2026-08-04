import type {
  AuthDeviceSession,
  ChangeEmailInput,
  ChangePasswordInput,
  DeleteAccountInput,
} from '@w3ds/types';

export type Role = 'creator' | 'moderator' | 'admin';

/** Active authentication provider selected by environment configuration. */
export type AuthProviderId = 'dev' | 'w3ds';

/**
 * Product profile projection for a signed-in user.
 * Not a MetaEnvelope — local platform shape only.
 */
export interface AuthUserProfile {
  displayName: string;
  handle?: string;
  avatarUrl?: string;
  bio?: string;
}

/**
 * Concrete permissions for UI affordances and API checks.
 * Derived from roles + capabilities + resource ownership.
 */
export interface AuthUserPermissions {
  canUpload: boolean;
  canComment: boolean;
  canManageOwnChannels: boolean;
  canModerate: boolean;
  canAccessAdmin: boolean;
}

/**
 * Platform projection of a signed-in identity.
 *
 * Backward-compatible top-level `displayName` / `avatarUrl` / `email` are retained
 * for existing UI. Prefer `profile.*` and W3DS identity fields for new code.
 */
export interface AuthUser {
  /** Local platform primary key (stable within Vidak). */
  id: string;

  /**
   * Development-provider compatibility / optional contact channel.
   * May be absent for pure eName identities.
   */
  email?: string;

  /** @deprecated Prefer `profile.displayName`. Kept for existing consumers. */
  displayName: string;

  /** @deprecated Prefer `profile.avatarUrl`. Kept for existing consumers. */
  avatarUrl?: string;

  roles: readonly Role[];

  /** Global W3ID / eName, always `@…`. Synthetic under the development provider. */
  eName: string;

  /** eVault instance identifier (Registry-resolved in production; synthetic in development). */
  eVaultId: string;

  /** Resolved eVault base URI (server-enriched; optional in UI). */
  eVaultUri?: string;

  profile: AuthUserProfile;

  /**
   * Capability flags granted by the platform session.
   * Examples: `video:upload`, `video:publish`, `comment:create`.
   */
  capabilities: readonly string[];

  permissions: AuthUserPermissions;
}

export interface AuthTokens {
  /**
   * Platform access credential.
   * Present for the development provider and Bearer API clients.
   * Omitted from browser-facing W3DS cookie sessions (HttpOnly cookie).
   */
  accessToken?: string;
  /** Omitted from JS when HTTP-only cookies are used (W3DS production). */
  refreshToken?: string;
  /** ISO timestamp for access token expiry. */
  expiresAt: string;
}

export interface AuthSession {
  user: AuthUser;
  tokens: AuthTokens;
  provider: AuthProviderId;
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

export interface UpdateAuthProfileInput {
  displayName: string;
  avatarUrl?: string | null;
}

/**
 * Product-facing sign-in challenge for the W3DS provider.
 * `signInUri` is an opaque deeplink/QR value — not a protocol teaching surface.
 */
export interface LoginChallenge {
  offerId: string;
  signInUri: string;
  expiresAt: string;
}

/** Status of a pending W3DS login challenge while the SPA polls for completion. */
export type LoginChallengeStatus =
  | { status: 'pending' }
  | { status: 'completed'; session: AuthSession }
  | { status: 'expired' }
  | { status: 'failed'; error: { code: string; message: string } };

/**
 * Capability matrix for the active authentication provider.
 * Feature UI should gate password vs challenge flows on these flags —
 * never on ad-hoc `provider === '…'` checks in feature components.
 */
export interface AuthProviderCapabilities {
  emailPasswordLogin: boolean;
  passwordRegistration: boolean;
  w3dsAuthChallenge: boolean;
  changePassword: boolean;
  changeEmail: boolean;
  /** Password-confirmed account deletion (development provider). */
  deleteAccount: boolean;
  /** List / revoke device sessions through the AuthClient. */
  manageSessions: boolean;
}

/**
 * Legacy auth contract used by settings and session helpers.
 * Prefer {@link AuthClient} for new provider-aware code.
 */
export interface AuthApi {
  login(input: LoginInput): Promise<AuthSession>;
  register(input: RegisterInput): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  getCurrentUser(accessToken: string): Promise<AuthUser>;
  logout(refreshToken?: string): Promise<void>;
  updateProfile(accessToken: string, input: UpdateAuthProfileInput): Promise<AuthUser>;
  changeEmail(accessToken: string, input: ChangeEmailInput): Promise<AuthUser>;
  changePassword(accessToken: string, input: ChangePasswordInput): Promise<void>;
  listSessions(accessToken: string): Promise<readonly AuthDeviceSession[]>;
  revokeSession(accessToken: string, sessionId: string): Promise<readonly AuthDeviceSession[]>;
  deleteAccount(accessToken: string, input: DeleteAccountInput): Promise<void>;
}

/**
 * Provider-driven authentication client.
 * Implementations: development (mock) and W3DS (platform HTTP).
 */
export interface AuthClient extends AuthApi {
  readonly provider: AuthProviderId;
  readonly capabilities: AuthProviderCapabilities;

  /**
   * Create a W3DS sign-in challenge (offer).
   * Unsupported for the development provider.
   */
  createLoginChallenge(): Promise<LoginChallenge>;

  /** Poll a W3DS sign-in challenge until it reaches a terminal state. */
  getLoginChallengeStatus(offerId: string): Promise<LoginChallengeStatus>;

  /**
   * Restore the current platform session.
   * W3DS uses same-origin cookies via `/api/auth/session` (+ refresh).
   * Development returns `null` and relies on browser token storage + `refresh`.
   */
  restoreSession(): Promise<AuthSession | null>;
}

export interface TokenStorage {
  read(): StoredAuthSession | undefined;
  write(session: StoredAuthSession): void;
  clear(): void;
}
