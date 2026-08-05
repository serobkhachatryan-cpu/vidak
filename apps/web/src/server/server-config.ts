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
import type { W3dsAdapterEntityType } from './w3ds-adapter-types';

export const MIN_W3DS_JWT_SECRET_LENGTH = 32;

/**
 * Documented Ontology production base URL (Ontology HTML / Links).
 * Operators may set W3DS_ONTOLOGY_BASE_URL to this value; schemaIds must still
 * come from GET /schemas and must not be guessed.
 */
export const DOCUMENTED_W3DS_ONTOLOGY_BASE_URL = 'https://ontology.w3ds.metastate.foundation';

export type ServerNodeEnv = 'development' | 'production' | 'test';

export type { W3dsAdapterEntityType };

export interface W3dsServerConfig {
  platformName: string;
  registryBaseUrl: string;
  jwtSecret: string;
  databaseUrl: string;
  minimumWalletVersion?: string;
  /**
   * Platform-owned eVault bootstrap is intentionally opt-in. A user eVault
   * (and its signing keys) is never reused as the platform eVault.
   */
  platformEVault: W3dsPlatformEVaultConfig | null;
  /**
   * Ontology + Web3 Adapter mapping foundation. Opt-in and fail-closed until
   * the Ontology base URL and every entity schemaId are supplied explicitly.
   * Schema IDs are never guessed from documentation examples.
   */
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
}

/** Server-only Ontology endpoint + configured schemaIds for adapter mappings. */
export interface W3dsOntologyAdapterConfig {
  ontologyBaseUrl: string;
  /** Mapping config version stamped onto durable ID map rows. */
  mappingVersion: number;
  schemaIds: Record<W3dsAdapterEntityType, string>;
}

/** Server-only configuration for the documented platform eVault bootstrap. */
export interface W3dsPlatformEVaultConfig {
  provisionerBaseUrl: string;
  verificationId: string;
  profile: {
    platformName: string;
    displayName: string;
    description: string;
    version: string;
    url: string;
    logoUrl: string;
    category: string;
  };
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

  const platformEVault = readPlatformEVaultConfig(env, platformName);
  const ontologyAdapter = readOntologyAdapterConfig(env);

  return {
    platformName,
    registryBaseUrl,
    jwtSecret,
    databaseUrl,
    platformEVault,
    ontologyAdapter,
    ...(env.W3DS_AUTH_MIN_WALLET_VERSION?.trim()
      ? { minimumWalletVersion: env.W3DS_AUTH_MIN_WALLET_VERSION.trim() }
      : {}),
  };
}

/**
 * Reads the documented Registry entropy → Provisioner → eVault profile flow.
 * It remains off until explicitly enabled so existing W3DS authentication can
 * be deployed independently of platform provisioning credentials.
 */
function readPlatformEVaultConfig(
  env: Record<string, string | undefined>,
  platformName: string,
): W3dsPlatformEVaultConfig | null {
  const enabledValue = env.W3DS_PLATFORM_EVAULT_ENABLED?.trim();
  if (!enabledValue || enabledValue === 'false') return null;
  if (enabledValue !== 'true') {
    throw new ServerConfigError('W3DS_PLATFORM_EVAULT_ENABLED must be "true" or "false".');
  }

  const provisionerBaseUrl = requireHttpUrl(
    env.W3DS_PROVISIONER_BASE_URL,
    'W3DS_PLATFORM_EVAULT_ENABLED requires W3DS_PROVISIONER_BASE_URL.',
  );
  const verificationId = requireValue(
    env.W3DS_PLATFORM_EVAULT_VERIFICATION_ID,
    'W3DS_PLATFORM_EVAULT_ENABLED requires W3DS_PLATFORM_EVAULT_VERIFICATION_ID.',
  );
  const url = requireHttpUrl(
    env.W3DS_PLATFORM_EVAULT_URL ?? env.APP_ORIGIN,
    'W3DS_PLATFORM_EVAULT_ENABLED requires W3DS_PLATFORM_EVAULT_URL or APP_ORIGIN.',
  );

  return {
    provisionerBaseUrl,
    verificationId,
    profile: {
      platformName,
      displayName: requireValue(
        env.W3DS_PLATFORM_EVAULT_DISPLAY_NAME,
        'W3DS_PLATFORM_EVAULT_ENABLED requires W3DS_PLATFORM_EVAULT_DISPLAY_NAME.',
      ),
      description: requireValue(
        env.W3DS_PLATFORM_EVAULT_DESCRIPTION,
        'W3DS_PLATFORM_EVAULT_ENABLED requires W3DS_PLATFORM_EVAULT_DESCRIPTION.',
      ),
      version: env.W3DS_PLATFORM_EVAULT_VERSION?.trim() || '1.0.0',
      url,
      logoUrl: optionalHttpUrl(
        env.W3DS_PLATFORM_EVAULT_LOGO_URL,
        'W3DS_PLATFORM_EVAULT_LOGO_URL must be an HTTP(S) URL when set.',
      ),
      category: requireValue(
        env.W3DS_PLATFORM_EVAULT_CATEGORY,
        'W3DS_PLATFORM_EVAULT_ENABLED requires W3DS_PLATFORM_EVAULT_CATEGORY.',
      ),
    },
  };
}

/**
 * Reads Ontology + adapter schema configuration.
 * Remains off until explicitly enabled so authentication and platform eVault
 * bootstrap can deploy independently of Video/Channel ontology contracts.
 */
function readOntologyAdapterConfig(
  env: Record<string, string | undefined>,
): W3dsOntologyAdapterConfig | null {
  const enabledValue = env.W3DS_ONTOLOGY_ADAPTER_ENABLED?.trim();
  if (!enabledValue || enabledValue === 'false') return null;
  if (enabledValue !== 'true') {
    throw new ServerConfigError('W3DS_ONTOLOGY_ADAPTER_ENABLED must be "true" or "false".');
  }

  const ontologyBaseUrl = requireHttpUrl(
    env.W3DS_ONTOLOGY_BASE_URL,
    'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_BASE_URL (Ontology GET /schemas).',
  );

  const mappingVersionRaw = env.W3DS_ADAPTER_MAPPING_VERSION?.trim() || '1';
  const mappingVersion = Number.parseInt(mappingVersionRaw, 10);
  if (!Number.isInteger(mappingVersion) || mappingVersion < 1) {
    throw new ServerConfigError(
      'W3DS_ADAPTER_MAPPING_VERSION must be a positive integer when set.',
    );
  }

  return {
    ontologyBaseUrl,
    mappingVersion,
    schemaIds: {
      profile: requireSchemaId(
        env.W3DS_ONTOLOGY_SCHEMA_ID_PROFILE,
        'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_PROFILE.',
      ),
      channel: requireSchemaId(
        env.W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL,
        'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL.',
      ),
      video: requireSchemaId(
        env.W3DS_ONTOLOGY_SCHEMA_ID_VIDEO,
        'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_VIDEO.',
      ),
      playlist: requireSchemaId(
        env.W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST,
        'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST.',
      ),
      comment: requireSchemaId(
        env.W3DS_ONTOLOGY_SCHEMA_ID_COMMENT,
        'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_COMMENT.',
      ),
    },
  };
}

function requireSchemaId(value: string | undefined, message: string): string {
  const normalized = requireValue(value, message);
  // Ontology documents schemaId as a W3ID; reject empty/placeholder guesses.
  if (
    normalized === 'TODO' ||
    normalized === 'changeme' ||
    normalized.toLowerCase() === 'undefined' ||
    normalized.toLowerCase() === 'null'
  ) {
    throw new ServerConfigError(`${message} Do not use placeholder schema IDs.`);
  }
  return normalized;
}

function requireValue(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ServerConfigError(message);
  return normalized;
}

function requireHttpUrl(value: string | undefined, message: string): string {
  const normalized = optionalHttpUrl(value, message);
  if (!normalized) throw new ServerConfigError(message);
  return normalized;
}

function optionalHttpUrl(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return url.toString();
  } catch {
    throw new ServerConfigError(message);
  }
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
