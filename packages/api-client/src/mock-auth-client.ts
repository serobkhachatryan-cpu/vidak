import {
  type AuthClient,
  AuthenticationError,
  type AuthProviderCapabilities,
  type AuthSession,
  type AuthUser,
  createAuthUser,
  getAuthProviderCapabilities,
  type LoginChallenge,
  type LoginChallengeStatus,
  type LoginInput,
  type RegisterInput,
  type UpdateAuthProfileInput,
} from '@w3ds/auth';
import type {
  AuthDeviceSession,
  ChangeEmailInput,
  ChangePasswordInput,
  DeleteAccountInput,
} from '@w3ds/types';
import { deleteAccountConfirmation } from '@w3ds/types';

export interface MockAuthApiClientOptions {
  delayMs?: number;
  users?: readonly MockAuthUser[];
}

/**
 * In-memory user record for the development auth provider.
 * Password stays local to the mock store and is never part of {@link AuthUser}.
 */
export interface MockAuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  roles: AuthUser['roles'];
  password: string;
  eName?: string;
  eVaultId?: string;
  handle?: string;
}

interface MockDeviceSession extends AuthDeviceSession {
  refreshToken: string;
  userId: string;
}

const defaultUsers: readonly MockAuthUser[] = [
  {
    id: 'user-demo',
    email: 'demo@w3ds.video',
    displayName: 'Demo Creator',
    roles: ['creator'],
    password: 'password123',
    eName: '@demo.w3id',
    eVaultId: 'evault-demo',
    handle: 'demo',
  },
];

function toAuthUser(user: MockAuthUser): AuthUser {
  return createAuthUser({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles,
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    ...(user.handle ? { handle: user.handle } : {}),
    ...(user.eName ? { eName: user.eName } : {}),
    ...(user.eVaultId ? { eVaultId: user.eVaultId } : {}),
  });
}

function isStrongPassword(password: string): boolean {
  return password.length >= 8;
}

/**
 * Development authentication provider (email/password, in-memory).
 * Also exported as {@link DevAuthClient}.
 */
export class MockAuthApiClient implements AuthClient {
  readonly provider = 'dev' as const;
  readonly capabilities: AuthProviderCapabilities = getAuthProviderCapabilities('dev');

  private readonly delayMs: number;
  private users: MockAuthUser[];
  private sessions = new Map<string, AuthUser>();
  private accessTokensByRefreshToken = new Map<string, Set<string>>();
  private revokedRefreshTokens = new Set<string>();
  private deviceSessions: MockDeviceSession[] = [];
  private sequence = 0;

  constructor(options: MockAuthApiClientOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.users = [...(options.users ?? defaultUsers)];
  }

  async login(input: LoginInput): Promise<AuthSession> {
    await this.wait();
    const user = this.users.find(
      (candidate) => candidate.email.toLocaleLowerCase() === input.email.trim().toLocaleLowerCase(),
    );
    if (!user || user.password !== input.password) {
      throw new AuthenticationError('Email or password is incorrect.', 'invalid_credentials');
    }
    return this.createSession(user);
  }

  async register(input: RegisterInput): Promise<AuthSession> {
    await this.wait();
    const email = input.email.trim().toLocaleLowerCase();
    if (this.users.some((user) => user.email.toLocaleLowerCase() === email)) {
      throw new AuthenticationError('An account already exists for this email.', 'email_in_use');
    }
    if (!isStrongPassword(input.password)) {
      throw new AuthenticationError('Password must be at least 8 characters.', 'weak_password');
    }
    const user: MockAuthUser = {
      id: `user-${this.users.length + 1}`,
      email,
      displayName: input.displayName.trim(),
      roles: ['creator'],
      password: input.password,
    };
    this.users = [...this.users, user];
    return this.createSession(user);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    await this.wait();
    if (this.revokedRefreshTokens.has(refreshToken)) {
      throw new AuthenticationError('Your session has expired.', 'invalid_session');
    }
    const user = this.sessions.get(refreshToken) ?? this.userFromToken(refreshToken, 'refresh.');
    if (!user) throw new AuthenticationError('Your session has expired.', 'invalid_session');
    const mockUser = this.users.find((candidate) => candidate.id === user.id);
    if (!mockUser) throw new AuthenticationError('Your session has expired.', 'invalid_session');
    return this.createSession(mockUser, refreshToken);
  }

  async getCurrentUser(accessToken: string): Promise<AuthUser> {
    await this.wait();
    const user = this.requireUser(accessToken);
    return toAuthUser(user);
  }

  async logout(refreshToken?: string): Promise<void> {
    await this.wait();
    if (refreshToken) {
      this.revokeRefreshToken(refreshToken);
    }
  }

  async createLoginChallenge(): Promise<LoginChallenge> {
    throw new AuthenticationError(
      'W3DS sign-in challenges are not available with the development provider.',
      'unsupported_capability',
    );
  }

  async getLoginChallengeStatus(_offerId: string): Promise<LoginChallengeStatus> {
    throw new AuthenticationError(
      'W3DS sign-in challenges are not available with the development provider.',
      'unsupported_capability',
    );
  }

  async restoreSession(): Promise<AuthSession | null> {
    // Development restore uses browser token storage + `refresh`.
    return null;
  }

  async updateProfile(accessToken: string, input: UpdateAuthProfileInput): Promise<AuthUser> {
    await this.wait();
    const user = this.requireUser(accessToken);
    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new AuthenticationError('Display name is required.', 'validation_failed');
    }
    user.displayName = displayName;
    if (input.avatarUrl === null) delete user.avatarUrl;
    else if (input.avatarUrl !== undefined) user.avatarUrl = input.avatarUrl;
    this.syncUserAcrossSessions(user);
    return toAuthUser(user);
  }

  async changeEmail(accessToken: string, input: ChangeEmailInput): Promise<AuthUser> {
    await this.wait();
    const user = this.requireUser(accessToken);
    if (user.password !== input.password) {
      throw new AuthenticationError('Current password is incorrect.', 'invalid_password');
    }
    const email = input.email.trim().toLocaleLowerCase();
    if (!email.includes('@')) {
      throw new AuthenticationError('Enter a valid email address.', 'validation_failed');
    }
    if (
      this.users.some(
        (candidate) => candidate.id !== user.id && candidate.email.toLocaleLowerCase() === email,
      )
    ) {
      throw new AuthenticationError('An account already exists for this email.', 'email_in_use');
    }
    user.email = email;
    this.syncUserAcrossSessions(user);
    return toAuthUser(user);
  }

  async changePassword(accessToken: string, input: ChangePasswordInput): Promise<void> {
    await this.wait();
    const user = this.requireUser(accessToken);
    if (user.password !== input.currentPassword) {
      throw new AuthenticationError('Current password is incorrect.', 'invalid_password');
    }
    if (!isStrongPassword(input.newPassword)) {
      throw new AuthenticationError('Password must be at least 8 characters.', 'weak_password');
    }
    if (input.newPassword === input.currentPassword) {
      throw new AuthenticationError(
        'New password must be different from your current password.',
        'weak_password',
      );
    }
    user.password = input.newPassword;
  }

  async listSessions(accessToken: string): Promise<readonly AuthDeviceSession[]> {
    await this.wait();
    const user = this.requireUser(accessToken);
    return this.deviceSessions
      .filter((session) => session.userId === user.id)
      .map(toPublicSession)
      .sort(
        (first, second) =>
          new Date(second.lastActiveAt).getTime() - new Date(first.lastActiveAt).getTime(),
      );
  }

  async revokeSession(
    accessToken: string,
    sessionId: string,
  ): Promise<readonly AuthDeviceSession[]> {
    await this.wait();
    const user = this.requireUser(accessToken);
    const session = this.deviceSessions.find(
      (candidate) => candidate.id === sessionId && candidate.userId === user.id,
    );
    if (!session) {
      throw new AuthenticationError('Session not found.', 'invalid_session');
    }
    if (session.current) {
      throw new AuthenticationError('You cannot revoke your current session.', 'invalid_session');
    }
    this.revokeRefreshToken(session.refreshToken);
    this.deviceSessions = this.deviceSessions.filter((candidate) => candidate.id !== sessionId);
    return this.deviceSessions
      .filter((candidate) => candidate.userId === user.id)
      .map(toPublicSession);
  }

  async deleteAccount(accessToken: string, input: DeleteAccountInput): Promise<void> {
    await this.wait();
    const user = this.requireUser(accessToken);
    if (user.password !== input.password) {
      throw new AuthenticationError('Current password is incorrect.', 'invalid_password');
    }
    if (input.confirmation.trim() !== deleteAccountConfirmation) {
      throw new AuthenticationError(
        `Type ${deleteAccountConfirmation} to confirm account deletion.`,
        'confirmation_mismatch',
      );
    }
    const refreshTokens = this.deviceSessions
      .filter((session) => session.userId === user.id)
      .map((session) => session.refreshToken);
    for (const refreshToken of refreshTokens) this.revokeRefreshToken(refreshToken);
    this.deviceSessions = this.deviceSessions.filter((session) => session.userId !== user.id);
    this.users = this.users.filter((candidate) => candidate.id !== user.id);
  }

  private createSession(user: MockAuthUser, existingRefreshToken?: string): AuthSession {
    const nonce = ++this.sequence;
    const refreshToken = existingRefreshToken ?? `refresh.${user.id}.${nonce}`;
    const accessToken = `access.${user.id}.${nonce}`;
    const authUser = toAuthUser(user);
    this.sessions.set(refreshToken, authUser);
    this.sessions.set(accessToken, authUser);
    const accessTokens = this.accessTokensByRefreshToken.get(refreshToken) ?? new Set<string>();
    accessTokens.add(accessToken);
    this.accessTokensByRefreshToken.set(refreshToken, accessTokens);

    const now = new Date().toISOString();
    if (existingRefreshToken) {
      const existing = this.deviceSessions.find(
        (session) => session.refreshToken === existingRefreshToken,
      );
      if (existing) {
        existing.lastActiveAt = now;
        existing.current = true;
        for (const session of this.deviceSessions) {
          if (session.userId === user.id && session.id !== existing.id) session.current = false;
        }
      }
    } else {
      for (const session of this.deviceSessions) {
        if (session.userId === user.id) session.current = false;
      }
      this.deviceSessions.push({
        id: `session-${user.id}-${nonce}`,
        userId: user.id,
        refreshToken,
        deviceName: nonce % 2 === 0 ? 'Chrome on macOS' : 'Safari on iPhone',
        location: nonce % 2 === 0 ? 'San Francisco, US' : 'London, UK',
        ipAddress: `203.0.113.${(nonce % 200) + 1}`,
        lastActiveAt: now,
        createdAt: now,
        current: true,
      });
    }

    return {
      user: authUser,
      provider: this.provider,
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };
  }

  private requireUser(accessToken: string): MockAuthUser {
    const sessionUser = this.sessions.get(accessToken);
    if (!sessionUser) {
      throw new AuthenticationError('Your session has expired.', 'invalid_session');
    }
    const user = this.users.find((candidate) => candidate.id === sessionUser.id);
    if (!user) {
      throw new AuthenticationError('Your session has expired.', 'invalid_session');
    }
    return user;
  }

  private syncUserAcrossSessions(user: MockAuthUser) {
    const authUser = toAuthUser(user);
    for (const [token, sessionUser] of this.sessions) {
      if (sessionUser.id === user.id) this.sessions.set(token, authUser);
    }
  }

  private revokeRefreshToken(refreshToken: string) {
    this.sessions.delete(refreshToken);
    for (const accessToken of this.accessTokensByRefreshToken.get(refreshToken) ?? []) {
      this.sessions.delete(accessToken);
    }
    this.accessTokensByRefreshToken.delete(refreshToken);
    this.revokedRefreshTokens.add(refreshToken);
  }

  private async wait(): Promise<void> {
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
  }

  private userFromToken(token: string, prefix: string): AuthUser | undefined {
    if (!token.startsWith(prefix)) return undefined;
    const userId = token.slice(prefix.length, token.lastIndexOf('.'));
    const user = this.users.find((candidate) => candidate.id === userId);
    return user ? toAuthUser(user) : undefined;
  }
}

/** Development auth provider — alias of {@link MockAuthApiClient}. */
export { MockAuthApiClient as DevAuthClient };

function toPublicSession(session: MockDeviceSession): AuthDeviceSession {
  return {
    id: session.id,
    deviceName: session.deviceName,
    lastActiveAt: session.lastActiveAt,
    createdAt: session.createdAt,
    current: session.current,
    ...(session.location ? { location: session.location } : {}),
    ...(session.ipAddress ? { ipAddress: session.ipAddress } : {}),
  };
}
