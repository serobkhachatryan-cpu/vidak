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
import { VIDAK_PRIVATE_SCHEMA_IDS } from './w3ds-private-ontology';
import {
  assertAllowedOfficialSchemaId,
  isDisallowedPlaceholderSchemaId,
  W3dsSchemaIdPolicyError,
} from './w3ds-schema-id-policy';

export const MIN_W3DS_JWT_SECRET_LENGTH = 32;

/**
 * Documented Ontology production base URL (Ontology HTML / Links).
 * Operators may set W3DS_ONTOLOGY_BASE_URL to this value; schemaIds must still
 * come from GET /schemas and must not be guessed.
 * `metastate_official` mode stays disabled unless W3DS_ONTOLOGY_MODE is set
 * explicitly — default platform catalogue mode is `vidak_private`.
 */
export const DOCUMENTED_W3DS_ONTOLOGY_BASE_URL = 'https://ontology.w3ds.metastate.foundation';

/**
 * Which Ontology catalogue the platform is configured to consume.
 * - `vidak_private` (default): Vidak-owned private catalogue at /api/w3ds/ontology
 * - `metastate_official`: MetaState production Ontology (explicit opt-in only)
 */
export type W3dsOntologyMode = 'vidak_private' | 'metastate_official';

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
   * Ontology catalogue selection. Defaults to Vidak private; MetaState official
   * requires an explicit W3DS_ONTOLOGY_MODE=metastate_official.
   */
  ontologyMode: W3dsOntologyMode;
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
  /**
   * Ontology catalogue mode for platform consumption.
   * Defaults to `vidak_private`. `metastate_official` is disabled unless set.
   */
  ontologyMode: W3dsOntologyMode;
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
  const ontologyMode = readW3dsOntologyMode(env);

  if (authProvider === 'w3ds') {
    const w3ds = readRequiredW3dsServerConfig(env);
    return {
      nodeEnv,
      authProvider,
      authProviderExplicit,
      ontologyMode,
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
    ontologyMode,
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
 * Whether Set-Cookie should include `Secure` for this response.
 *
 * Browsers silently drop `Secure` cookies on plain HTTP. Production NODE_ENV
 * behind a local reverse proxy (e.g. http://127.0.0.1:3910) must not force
 * Secure unless the client connection is actually HTTPS (URL or
 * X-Forwarded-Proto).
 */
export function resolveRequestCookieSecure(request: Request): boolean {
  try {
    if (new URL(request.url).protocol === 'https:') return true;
  } catch {
    // Malformed request URL — fall through to forwarded proto.
  }
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return forwarded === 'https';
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
  const e2eStub = resolveServerNodeEnv(env) !== 'production' && env.W3DS_AUTH_E2E_STUB === '1';

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
  if (!databaseUrl && !e2eStub) {
    throw new ServerConfigError(
      'W3DS authentication requires DATABASE_URL for durable session persistence. Incomplete W3DS configuration cannot fall back to development authentication.',
    );
  }

  const platformEVault = readPlatformEVaultConfig(env, platformName);
  const ontologyMode = readW3dsOntologyMode(env);
  const ontologyAdapter = readOntologyAdapterConfig(env, ontologyMode);

  return {
    platformName,
    registryBaseUrl,
    jwtSecret,
    // E2E stub never opens this URL; auth uses an in-memory store instead.
    databaseUrl: databaseUrl ?? 'postgresql://127.0.0.1/vidak-e2e-stub-unused',
    platformEVault,
    ontologyMode,
    ontologyAdapter,
    ...(env.W3DS_AUTH_MIN_WALLET_VERSION?.trim()
      ? { minimumWalletVersion: env.W3DS_AUTH_MIN_WALLET_VERSION.trim() }
      : {}),
  };
}

/**
 * Reads Ontology catalogue mode.
 * Default is `vidak_private` (Vidak-owned private catalogue).
 * `metastate_official` remains disabled unless operators set it explicitly.
 */
export function readW3dsOntologyMode(
  env: Record<string, string | undefined> = process.env,
): W3dsOntologyMode {
  const raw = env.W3DS_ONTOLOGY_MODE?.trim();
  if (!raw || raw === 'vidak_private') return 'vidak_private';
  if (raw === 'metastate_official') return 'metastate_official';
  throw new ServerConfigError(
    'W3DS_ONTOLOGY_MODE must be "vidak_private" or "metastate_official".',
  );
}

/**
 * AaaS webhook HMAC configuration. Both secret and encoding must be set
 * explicitly. There is no default encoding and no hex/base64 fallback.
 * Incomplete or invalid configuration is unavailable (handler fail-closes).
 */
export type W3dsAaasSignatureEncoding = 'hex' | 'base64';

export interface W3dsAaasWebhookConfig {
  secret: string;
  encoding: W3dsAaasSignatureEncoding;
}

export function readW3dsAaasWebhookConfig(
  env: Record<string, string | undefined> = process.env,
): W3dsAaasWebhookConfig | null {
  const secret = env.W3DS_AAAS_WEBHOOK_SECRET?.trim();
  const encoding = env.W3DS_AAAS_SIGNATURE_ENCODING?.trim();
  if (!secret || (encoding !== 'hex' && encoding !== 'base64')) {
    return null;
  }
  return { secret, encoding };
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
 *
 * In `vidak_private` mode, Video/Channel/Playlist/Comment schema IDs default to
 * the immutable Vidak private catalogue IDs (not MetaState W3IDs).
 * In `metastate_official` mode, every schema ID must be supplied explicitly and
 * must not use Vidak private IDs.
 */
function readOntologyAdapterConfig(
  env: Record<string, string | undefined>,
  ontologyMode: W3dsOntologyMode,
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

  if (ontologyMode === 'vidak_private') {
    const profile = requireSchemaId(
      env.W3DS_ONTOLOGY_SCHEMA_ID_PROFILE,
      'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_PROFILE.',
    );
    return {
      ontologyBaseUrl,
      mappingVersion,
      schemaIds: {
        profile,
        channel: resolvePrivateOrConfiguredSchemaId(
          env.W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL,
          VIDAK_PRIVATE_SCHEMA_IDS.Channel,
          'CHANNEL',
        ),
        video: resolvePrivateOrConfiguredSchemaId(
          env.W3DS_ONTOLOGY_SCHEMA_ID_VIDEO,
          VIDAK_PRIVATE_SCHEMA_IDS.Video,
          'VIDEO',
        ),
        playlist: resolvePrivateOrConfiguredSchemaId(
          env.W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST,
          VIDAK_PRIVATE_SCHEMA_IDS.Playlist,
          'PLAYLIST',
        ),
        comment: resolvePrivateOrConfiguredSchemaId(
          env.W3DS_ONTOLOGY_SCHEMA_ID_COMMENT,
          VIDAK_PRIVATE_SCHEMA_IDS.Comment,
          'COMMENT',
        ),
      },
    };
  }

  // metastate_official — explicit MetaState catalogue only. Example ontology
  // UUIDs, private IDs, and ASSIGNED_BY_METASTATE placeholders are rejected.
  const schemaIds = {
    profile: requireOfficialSchemaId(
      'profile',
      env.W3DS_ONTOLOGY_SCHEMA_ID_PROFILE,
      'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_PROFILE.',
    ),
    channel: requireOfficialSchemaId(
      'channel',
      env.W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL,
      'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_CHANNEL.',
    ),
    video: requireOfficialSchemaId(
      'video',
      env.W3DS_ONTOLOGY_SCHEMA_ID_VIDEO,
      'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_VIDEO.',
    ),
    playlist: requireOfficialSchemaId(
      'playlist',
      env.W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST,
      'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_PLAYLIST.',
    ),
    comment: requireOfficialSchemaId(
      'comment',
      env.W3DS_ONTOLOGY_SCHEMA_ID_COMMENT,
      'W3DS_ONTOLOGY_ADAPTER_ENABLED requires W3DS_ONTOLOGY_SCHEMA_ID_COMMENT.',
    ),
  };

  return {
    ontologyBaseUrl,
    mappingVersion,
    schemaIds,
  };
}

function resolvePrivateOrConfiguredSchemaId(
  configured: string | undefined,
  privateId: string,
  envSuffix: string,
): string {
  const trimmed = configured?.trim();
  if (!trimmed) return privateId;
  const normalized = requireSchemaId(trimmed, `W3DS_ONTOLOGY_SCHEMA_ID_${envSuffix} is invalid.`);
  if (normalized !== privateId) {
    throw new ServerConfigError(
      `W3DS_ONTOLOGY_MODE=vidak_private requires W3DS_ONTOLOGY_SCHEMA_ID_${envSuffix} to be "${privateId}" (Vidak-owned private ID) or omitted.`,
    );
  }
  return normalized;
}

function requireOfficialSchemaId(
  entityType: W3dsAdapterEntityType,
  value: string | undefined,
  message: string,
): string {
  const normalized = requireSchemaId(value, message);
  try {
    assertAllowedOfficialSchemaId(entityType, normalized);
  } catch (error) {
    const detail = error instanceof W3dsSchemaIdPolicyError ? error.message : String(error);
    throw new ServerConfigError(detail);
  }
  return normalized;
}

function requireSchemaId(value: string | undefined, message: string): string {
  const normalized = requireValue(value, message);
  // Ontology documents schemaId as a W3ID; reject empty/placeholder guesses.
  if (isDisallowedPlaceholderSchemaId(normalized)) {
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
