import type {
  AuthDeviceSession,
  ChangeEmailInput,
  ChangePasswordInput,
  DeleteAccountInput,
} from '@w3ds/types';

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

export interface UpdateAuthProfileInput {
  displayName: string;
  avatarUrl?: string | null;
}

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

export interface TokenStorage {
  read(): StoredAuthSession | undefined;
  write(session: StoredAuthSession): void;
  clear(): void;
}
