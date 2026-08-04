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

export interface TokenStorage {
  read(): StoredAuthSession | undefined;
  write(session: StoredAuthSession): void;
  clear(): void;
}
