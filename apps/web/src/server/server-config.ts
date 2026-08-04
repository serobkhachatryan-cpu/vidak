/**
 * Centralized server-side security configuration.
 * Validates auth provider, W3DS, cookie, storage, and trusted-origin settings.
 * Secrets stay server-only — never read or return `NEXT_PUBLIC_*` secret values.
 */

import { type AuthProviderId, parseAuthProviderId } from '@w3ds/auth';
import {
  DEFAULT_ALLOWED_MEDIA_CONTENT_TYPES,
  DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
  type MediaUploadLimits,
  resolveMediaUploadLimits,
} from './media-limits';
import { resolveLocalMediaStorageRoot } from './media-storage';

export const MIN_W3DS_JWT_SECRET_LENGTH = 32;

export type ServerNodeEnv = 'development' | 'production' | 'test';

export interface W3dsServerConfig {
  platformName: string;
  registryBaseUrl: string;
  jwtSecret: string;
  databaseUrl: string;
  minimumWalletVersion?: string;
}

export interface CookieSecurityConfig {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
}

export interface ServerSecurityConfig {
  nodeEnv: ServerNodeEnv;
  authProvider: AuthProviderId;
  /** Explicit server AUTH_PROVIDER was set (not inferred from defaults). */
  authProviderExplicit: boolean;
  w3ds: W3dsServerConfig | null;
  cookies: CookieSecurityConfig;
  /** Canonical app origin and any additional trusted browser origins. */
  trustedOrigins: readonly string[];
  mediaStorageRoot: string;
  mediaUploadLimits: MediaUploadLimits;
}

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerConfigError';
  }
}

export function resolveServerNodeEnv(
  env: Record<string, string | undefined> = process.env,
): ServerNodeEnv {
  const value = env.NODE_ENV?.trim();
  if (value === 'production') return 'production';
  if (value === 'test') return 'test';
  return 'development';
}

/**
 * Loads and validates server security configuration.
 * Development may default to `AUTH_PROVIDER=dev`. Production requires an
 * explicit provider and rejects incomplete W3DS settings instead of falling back.
 */
export function loadServerSecurityConfig(
  env: Record<string, string | undefined> = process.env,
): ServerSecurityConfig {
  const nodeEnv = resolveServerNodeEnv(env);
  const rawProvider = env.AUTH_PROVIDER?.trim();
  const authProviderExplicit = Boolean(rawProvider);

  if (nodeEnv === 'production' && !authProviderExplicit) {
    throw new ServerConfigError(
      'AUTH_PROVIDER must be set explicitly in production ("dev" or "w3ds"). Silent development fallback is not allowed.',
    );
  }

  let authProvider: AuthProviderId;
  try {
    authProvider = parseAuthProviderId(rawProvider || undefined);
  } catch (error) {
    throw new ServerConfigError(error instanceof Error ? error.message : String(error));
  }

  const cookies = resolveCookieSecurityConfig(nodeEnv);
  const trustedOrigins = resolveTrustedOrigins(env, nodeEnv, authProvider);
  const processEnv = env as NodeJS.ProcessEnv;
  const mediaUploadLimits = resolveMediaUploadLimits(processEnv);
  const mediaStorageRoot = resolveLocalMediaStorageRoot(processEnv);

  if (authProvider === 'w3ds') {
    const w3ds = readRequiredW3dsServerConfig(env);
    return {
      nodeEnv,
      authProvider,
      authProviderExplicit,
      w3ds,
      cookies,
      trustedOrigins,
      mediaStorageRoot,
      mediaUploadLimits,
    };
  }

  // Development provider: W3DS secrets are optional and unused.
  return {
    nodeEnv,
    authProvider,
    authProviderExplicit,
    w3ds: tryReadW3dsServerConfig(env),
    cookies,
    trustedOrigins,
    mediaStorageRoot,
    mediaUploadLimits,
  };
}

/** Fail-fast validation for Node server startup (instrumentation). */
export function validateServerConfigAtStartup(
  env: Record<string, string | undefined> = process.env,
): ServerSecurityConfig {
  return loadServerSecurityConfig(env);
}

export function resolveCookieSecurityConfig(nodeEnv: ServerNodeEnv): CookieSecurityConfig {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: nodeEnv === 'production',
    path: '/',
  };
}

/**
 * Trusted browser origins for cookie-authenticated mutations.
 * Production W3DS requires APP_ORIGIN (and optional TRUSTED_ORIGINS).
 */
export function resolveTrustedOrigins(
  env: Record<string, string | undefined>,
  nodeEnv: ServerNodeEnv,
  authProvider: AuthProviderId,
): readonly string[] {
  const origins = new Set<string>();
  const appOrigin = normalizeOrigin(env.APP_ORIGIN);
  if (appOrigin) origins.add(appOrigin);

  const extras = env.TRUSTED_ORIGINS?.split(',') ?? [];
  for (const value of extras) {
    const origin = normalizeOrigin(value);
    if (origin) origins.add(origin);
  }

  if (nodeEnv === 'production' && authProvider === 'w3ds' && origins.size === 0) {
    throw new ServerConfigError(
      'APP_ORIGIN is required in production when AUTH_PROVIDER=w3ds (optional TRUSTED_ORIGINS for additional browser origins).',
    );
  }

  return [...origins];
}

export function isW3dsAuthConfigured(env: Record<string, string | undefined>): boolean {
  try {
    readRequiredW3dsServerConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function readRequiredW3dsServerConfig(
  env: Record<string, string | undefined>,
): W3dsServerConfig {
  const platformName = env.W3DS_AUTH_PLATFORM_NAME?.trim() || 'vidak';
  const registryBaseUrl = env.W3DS_REGISTRY_BASE_URL?.trim();
  const jwtSecret = env.W3DS_AUTH_JWT_SECRET;
  const databaseUrl = env.DATABASE_URL?.trim();

  if (!registryBaseUrl) {
    throw new ServerConfigError(
      'W3DS authentication requires W3DS_REGISTRY_BASE_URL. Incomplete W3DS configuration cannot fall back to development authentication.',
    );
  }
  if (!jwtSecret || jwtSecret.length < MIN_W3DS_JWT_SECRET_LENGTH) {
    throw new ServerConfigError(
      `W3DS authentication requires W3DS_AUTH_JWT_SECRET with at least ${MIN_W3DS_JWT_SECRET_LENGTH} characters. Never expose this secret via NEXT_PUBLIC_*.`,
    );
  }
  if (!databaseUrl) {
    throw new ServerConfigError(
      'W3DS authentication requires DATABASE_URL for durable session persistence. Incomplete W3DS configuration cannot fall back to development authentication.',
    );
  }

  return {
    platformName,
    registryBaseUrl,
    jwtSecret,
    databaseUrl,
    ...(env.W3DS_AUTH_MIN_WALLET_VERSION?.trim()
      ? { minimumWalletVersion: env.W3DS_AUTH_MIN_WALLET_VERSION.trim() }
      : {}),
  };
}

function tryReadW3dsServerConfig(env: Record<string, string | undefined>): W3dsServerConfig | null {
  try {
    return readRequiredW3dsServerConfig(env);
  } catch {
    return null;
  }
}

/** Normalizes a URL or origin string to `scheme://host[:port]`. */
export function normalizeOrigin(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Public defaults re-exported for documentation/tests. */
export const serverConfigDefaults = {
  maxMediaUploadBytes: DEFAULT_MAX_MEDIA_UPLOAD_BYTES,
  allowedMediaContentTypes: DEFAULT_ALLOWED_MEDIA_CONTENT_TYPES,
} as const;
