import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { ChannelImportProvider, ChannelImportProviderStatus } from '@w3ds/types';
import { normalizeOrigin } from './server-config';

const minimumSecretLength = 32;
const providers: readonly ChannelImportProvider[] = ['youtube', 'vimeo'];

export interface ChannelImportProviderConfig {
  provider: ChannelImportProvider;
  label: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  callbackUrl: string;
  scopes: readonly string[];
}

export interface ChannelImportSecurityConfig {
  stateSecret: string;
  encryptionKey: Buffer;
}

/**
 * Returns only public availability — no client IDs, callback secrets, tokens,
 * or environment error detail may cross this boundary.
 */
export function listChannelImportProviderStatuses(
  env: Record<string, string | undefined> = process.env,
): ChannelImportProviderStatus[] {
  return providers.map((provider) => ({
    provider,
    label: provider === 'youtube' ? 'YouTube' : 'Vimeo',
    available: Boolean(readChannelImportProviderConfig(provider, env)),
  }));
}

/**
 * Providers remain disabled until every dependency is present. This avoids a
 * Settings button that redirects users into an incomplete OAuth flow.
 */
export function readChannelImportProviderConfig(
  provider: ChannelImportProvider,
  env: Record<string, string | undefined> = process.env,
): ChannelImportProviderConfig | null {
  const appOrigin = normalizeOrigin(env.APP_ORIGIN);
  const security = readChannelImportSecurityConfig(env);
  if (!appOrigin || !security) return null;

  const clientId =
    env[provider === 'youtube' ? 'YOUTUBE_OAUTH_CLIENT_ID' : 'VIMEO_OAUTH_CLIENT_ID']?.trim();
  const clientSecret =
    env[
      provider === 'youtube' ? 'YOUTUBE_OAUTH_CLIENT_SECRET' : 'VIMEO_OAUTH_CLIENT_SECRET'
    ]?.trim();
  if (!clientId || !clientSecret) return null;

  return provider === 'youtube'
    ? {
        provider,
        label: 'YouTube',
        clientId,
        clientSecret,
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        callbackUrl: new URL('/api/channel-imports/callback/youtube', appOrigin).toString(),
        scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      }
    : {
        provider,
        label: 'Vimeo',
        clientId,
        clientSecret,
        authorizationEndpoint: 'https://api.vimeo.com/oauth/authorize',
        tokenEndpoint: 'https://api.vimeo.com/oauth/access_token',
        callbackUrl: new URL('/api/channel-imports/callback/vimeo', appOrigin).toString(),
        scopes: ['public'],
      };
}

/** Server-only state HMAC and AES-256-GCM key material. */
export function readChannelImportSecurityConfig(
  env: Record<string, string | undefined> = process.env,
): ChannelImportSecurityConfig | null {
  const stateSecret = env.CHANNEL_IMPORT_STATE_SECRET?.trim();
  const rawEncryptionKey = env.CHANNEL_IMPORT_TOKEN_ENCRYPTION_KEY?.trim();
  if (!stateSecret || stateSecret.length < minimumSecretLength || !rawEncryptionKey) return null;

  let encryptionKey: Buffer;
  try {
    encryptionKey = Buffer.from(rawEncryptionKey, 'base64');
  } catch {
    return null;
  }
  return encryptionKey.length === 32 ? { stateSecret, encryptionKey } : null;
}

export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

/** Persists a non-reversible HMAC instead of the browser's callback value. */
export function hashOAuthState(state: string, stateSecret: string): string {
  return createHmac('sha256', stateSecret).update(state).digest('base64url');
}

/** Stable correlation reference safe for error telemetry; not a secret or token. */
export function stateReference(state: string): string {
  return createHash('sha256').update(state).digest('hex').slice(0, 12);
}

export function buildProviderAuthorizationUrl(
  config: ChannelImportProviderConfig,
  state: string,
): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', config.scopes.join(' '));
  if (config.provider === 'youtube') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    // Google only returns a refresh credential after consent when it has none.
    url.searchParams.set('prompt', 'consent');
  }
  return url.toString();
}
