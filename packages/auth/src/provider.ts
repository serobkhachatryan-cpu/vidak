import type {
  AuthProviderCapabilities,
  AuthProviderId,
  AuthUser,
  AuthUserPermissions,
  AuthUserProfile,
  Role,
} from './types';

export const authProviderCapabilities = {
  dev: {
    emailPasswordLogin: true,
    passwordRegistration: true,
    w3dsAuthChallenge: false,
    changePassword: true,
    changeEmail: true,
    deleteAccount: true,
    manageSessions: true,
    connectExternalAccounts: true,
  },
  w3ds: {
    emailPasswordLogin: false,
    passwordRegistration: false,
    w3dsAuthChallenge: true,
    changePassword: false,
    changeEmail: false,
    deleteAccount: false,
    manageSessions: true,
    connectExternalAccounts: false,
  },
} as const satisfies Record<AuthProviderId, AuthProviderCapabilities>;

export function getAuthProviderCapabilities(provider: AuthProviderId): AuthProviderCapabilities {
  return authProviderCapabilities[provider];
}

export function parseAuthProviderId(value: string | undefined): AuthProviderId {
  const normalized = value?.trim().toLocaleLowerCase();
  if (normalized === 'w3ds') return 'w3ds';
  if (normalized === undefined || normalized === '' || normalized === 'dev') return 'dev';
  throw new Error(`Unsupported auth provider "${value}". Expected "dev" or "w3ds".`);
}

/**
 * Reads the configured auth provider from environment.
 * Prefers `NEXT_PUBLIC_AUTH_PROVIDER` (browser-safe), then `AUTH_PROVIDER`.
 * Defaults to `dev`.
 */
export function resolveAuthProviderId(
  value: string | undefined = readAuthProviderEnv(),
): AuthProviderId {
  return parseAuthProviderId(value);
}

export function readAuthProviderEnv(
  env: Record<string, string | undefined> = getProcessEnv(),
): string | undefined {
  return env.NEXT_PUBLIC_AUTH_PROVIDER ?? env.AUTH_PROVIDER;
}

function getProcessEnv(): Record<string, string | undefined> {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env ?? {};
}

export function permissionsFromRoles(roles: readonly Role[]): AuthUserPermissions {
  const canModerate = roles.includes('moderator') || roles.includes('admin');
  const canAccessAdmin = roles.includes('admin');
  const canManage =
    roles.includes('creator') || roles.includes('moderator') || roles.includes('admin');

  return {
    canUpload: canManage,
    canComment: true,
    canManageOwnChannels: canManage,
    canModerate,
    canAccessAdmin,
  };
}

export function capabilitiesFromRoles(roles: readonly Role[]): readonly string[] {
  const capabilities: string[] = ['comment:create'];
  if (roles.includes('creator') || roles.includes('moderator') || roles.includes('admin')) {
    capabilities.push('video:upload', 'video:publish', 'channel:manage');
  }
  if (roles.includes('moderator') || roles.includes('admin')) {
    capabilities.push('moderation:act');
  }
  return capabilities;
}

function slugifyIdentitySegment(value: string): string {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'user';
}

/** Synthetic eName for the development provider (not a Registry identity). */
export function createSyntheticEName(userId: string, handle?: string): string {
  const segment = slugifyIdentitySegment(handle ?? userId);
  return `@${segment}.w3id`;
}

/** Synthetic eVault id for the development provider. */
export function createSyntheticEVaultId(userId: string): string {
  return `evault-${slugifyIdentitySegment(userId)}`;
}

export interface CreateAuthUserInput {
  id: string;
  displayName: string;
  roles: readonly Role[];
  email?: string;
  avatarUrl?: string;
  handle?: string;
  bio?: string;
  eName?: string;
  eVaultId?: string;
  eVaultUri?: string;
  capabilities?: readonly string[];
  permissions?: AuthUserPermissions;
}

/**
 * Builds a platform auth user projection.
 * Fills synthetic W3DS identity fields when omitted (development provider).
 */
export function createAuthUser(input: CreateAuthUserInput): AuthUser {
  const profile: AuthUserProfile = {
    displayName: input.displayName,
    ...(input.handle ? { handle: input.handle } : {}),
    ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
    ...(input.bio ? { bio: input.bio } : {}),
  };

  return {
    id: input.id,
    ...(input.email !== undefined ? { email: input.email } : {}),
    displayName: input.displayName,
    ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
    roles: input.roles,
    eName: input.eName ?? createSyntheticEName(input.id, input.handle),
    eVaultId: input.eVaultId ?? createSyntheticEVaultId(input.id),
    ...(input.eVaultUri ? { eVaultUri: input.eVaultUri } : {}),
    profile,
    capabilities: input.capabilities ?? capabilitiesFromRoles(input.roles),
    permissions: input.permissions ?? permissionsFromRoles(input.roles),
  };
}
