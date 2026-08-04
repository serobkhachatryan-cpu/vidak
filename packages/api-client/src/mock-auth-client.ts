import {
  type AuthApi,
  AuthenticationError,
  type AuthSession,
  type AuthUser,
  type LoginInput,
  type RegisterInput,
} from '@w3ds/auth';

export interface MockAuthApiClientOptions {
  delayMs?: number;
  users?: readonly MockAuthUser[];
}

export interface MockAuthUser extends AuthUser {
  password: string;
}

const defaultUsers: readonly MockAuthUser[] = [
  {
    id: 'user-demo',
    email: 'demo@w3ds.video',
    displayName: 'Demo Creator',
    roles: ['creator'],
    password: 'password123',
  },
];

export class MockAuthApiClient implements AuthApi {
  private readonly delayMs: number;
  private users: MockAuthUser[];
  private sessions = new Map<string, AuthUser>();
  private accessTokensByRefreshToken = new Map<string, Set<string>>();
  private revokedRefreshTokens = new Set<string>();
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
    return this.createSession(user, refreshToken);
  }

  async getCurrentUser(accessToken: string): Promise<AuthUser> {
    await this.wait();
    const user = this.sessions.get(accessToken);
    if (!user) throw new AuthenticationError('Your session has expired.', 'invalid_session');
    return user;
  }

  async logout(refreshToken?: string): Promise<void> {
    await this.wait();
    if (refreshToken) {
      this.sessions.delete(refreshToken);
      for (const accessToken of this.accessTokensByRefreshToken.get(refreshToken) ?? []) {
        this.sessions.delete(accessToken);
      }
      this.accessTokensByRefreshToken.delete(refreshToken);
      this.revokedRefreshTokens.add(refreshToken);
    }
  }

  private createSession(user: AuthUser, existingRefreshToken?: string): AuthSession {
    const nonce = ++this.sequence;
    const refreshToken = existingRefreshToken ?? `refresh.${user.id}.${nonce}`;
    const accessToken = `access.${user.id}.${nonce}`;
    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roles: user.roles,
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    };
    this.sessions.set(refreshToken, authUser);
    this.sessions.set(accessToken, authUser);
    const accessTokens = this.accessTokensByRefreshToken.get(refreshToken) ?? new Set<string>();
    accessTokens.add(accessToken);
    this.accessTokensByRefreshToken.set(refreshToken, accessTokens);
    return {
      user: authUser,
      tokens: {
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };
  }

  private async wait(): Promise<void> {
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
  }

  private userFromToken(token: string, prefix: string): AuthUser | undefined {
    if (!token.startsWith(prefix)) return undefined;
    const userId = token.slice(prefix.length, token.lastIndexOf('.'));
    return this.users.find((user) => user.id === userId);
  }
}
