import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@w3ds/auth';
import type {
  ChannelImportProvider,
  ChannelImportProviderStatus,
  ImportedChannel,
} from '@w3ds/types';
import 'server-only';
import {
  buildProviderAuthorizationUrl,
  createOAuthState,
  hashOAuthState,
  listChannelImportProviderStatuses,
  readChannelImportProviderConfig,
  readChannelImportSecurityConfig,
  type ChannelImportProviderConfig,
} from './channel-import-config';
import { encryptChannelImportCredential } from './channel-import-crypto';
import { getW3dsDatabase } from './db/client';
import {
  InMemoryChannelImportStore,
  PostgresChannelImportStore,
  type ChannelImportStore,
} from './channel-import-store';
import { getW3dsAuthService } from './w3ds-auth';

const stateLifetimeMs = 10 * 60 * 1000;
const providerRequestTimeoutMs = 10_000;

export interface ChannelImportServiceOptions {
  store: ChannelImportStore;
  resolveUser?: (accessToken: string) => Promise<AuthUser>;
  fetch?: typeof globalThis.fetch;
  createId?: () => string;
  createState?: () => string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export class ChannelImportError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_provider'
      | 'provider_unavailable'
      | 'invalid_state'
      | 'authorization_denied'
      | 'authorization_failed'
      | 'invalid_session',
    public readonly status: 400 | 401 | 403 | 503,
  ) {
    super(message);
  }
}

interface ProviderToken {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt?: Date;
}

interface SourceChannel {
  id: string;
  title: string;
  sourceUrl: string;
  thumbnailUrl?: string;
}

/**
 * Owns external-provider OAuth only. It reads one creator's authorised source
 * channel metadata; it does not fetch, proxy, or claim ownership of video
 * files. That separation keeps linked-source imports honest and safe.
 */
export class ChannelImportService {
  private readonly store: ChannelImportStore;
  private readonly resolveUser: (accessToken: string) => Promise<AuthUser>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly createId: () => string;
  private readonly createState: () => string;
  private readonly now: () => Date;
  private readonly env: Record<string, string | undefined>;

  constructor(options: ChannelImportServiceOptions) {
    this.store = options.store;
    this.resolveUser =
      options.resolveUser ??
      (async (accessToken) => (await getW3dsAuthService().getSession(accessToken)).user);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createId = options.createId ?? randomUUID;
    this.createState = options.createState ?? createOAuthState;
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
  }

  providerStatuses(): ChannelImportProviderStatus[] {
    return listChannelImportProviderStatuses(this.env);
  }

  async listImportedChannels(accessToken: string): Promise<ImportedChannel[]> {
    const user = await this.requireUser(accessToken);
    return this.store.listImportedChannelsByOwnerId(user.id);
  }

  async beginAuthorization(
    accessToken: string,
    providerInput: unknown,
  ): Promise<{ authorizationUrl: string }> {
    const user = await this.requireUser(accessToken);
    const provider = parseProvider(providerInput);
    const config = readChannelImportProviderConfig(provider, this.env);
    const security = readChannelImportSecurityConfig(this.env);
    if (!config || !security) {
      throw new ChannelImportError(
        providerLabel(provider) + ' import is not available yet.',
        'provider_unavailable',
        503,
      );
    }

    const state = this.createState();
    if (!isValidState(state)) {
      throw new ChannelImportError('Could not start channel import.', 'authorization_failed', 400);
    }
    const now = this.now();
    await this.store.createOAuthState({
      id: this.createId(),
      ownerId: user.id,
      provider,
      stateHash: hashOAuthState(state, security.stateSecret),
      expiresAt: new Date(now.getTime() + stateLifetimeMs),
      now,
    });
    return { authorizationUrl: buildProviderAuthorizationUrl(config, state) };
  }

  async completeAuthorization(input: {
    accessToken: string;
    providerInput: unknown;
    state: string;
    code: string;
  }): Promise<{ importedChannels: number }> {
    const user = await this.requireUser(input.accessToken);
    const provider = parseProvider(input.providerInput);
    const config = readChannelImportProviderConfig(provider, this.env);
    const security = readChannelImportSecurityConfig(this.env);
    if (!config || !security) {
      throw new ChannelImportError(
        providerLabel(provider) + ' import is not available yet.',
        'provider_unavailable',
        503,
      );
    }
    if (!isValidState(input.state) || !input.code.trim()) {
      throw new ChannelImportError('This channel-import approval is invalid.', 'invalid_state', 400);
    }

    const now = this.now();
    const claimed = await this.store.consumeOAuthState({
      provider,
      stateHash: hashOAuthState(input.state, security.stateSecret),
      now,
    });
    if (!claimed || claimed.ownerId !== user.id) {
      throw new ChannelImportError('This channel-import approval has expired.', 'invalid_state', 400);
    }

    const token = await this.exchangeAuthorizationCode(config, input.code.trim());
    const sourceChannels = await this.readSourceChannels(config, token.accessToken);
    if (sourceChannels.length === 0) {
      throw new ChannelImportError(
        'No ' + providerLabel(provider) + ' channel was found for the approved account.',
        'authorization_failed',
        400,
      );
    }

    // Provider APIs do not expose a durable universal account id with these
    // minimal scopes. The first returned owned channel is a stable source key;
    // all selected channels share this encrypted authorisation connection.
    const providerAccountId = sourceChannels[0]!.id;
    const connection = await this.store.upsertConnection({
      id: this.createId(),
      ownerId: user.id,
      provider,
      providerAccountId,
      accountLabel: sourceChannels[0]!.title,
      encryptedAccessToken: encryptChannelImportCredential(token.accessToken, security.encryptionKey),
      ...(token.refreshToken
        ? { encryptedRefreshToken: encryptChannelImportCredential(token.refreshToken, security.encryptionKey) }
        : {}),
      grantedScopes: token.scopes,
      ...(token.expiresAt ? { accessTokenExpiresAt: token.expiresAt } : {}),
      now,
    });
    await this.store.upsertImportedChannels(
      sourceChannels.map((channel) => ({
        id: this.createId(),
        connectionId: connection.id,
        sourceChannelId: channel.id,
        title: channel.title,
        sourceUrl: channel.sourceUrl,
        ...(channel.thumbnailUrl ? { thumbnailUrl: channel.thumbnailUrl } : {}),
        status: 'connected' as const,
        now,
      })),
    );

    return { importedChannels: sourceChannels.length };
  }

  private async exchangeAuthorizationCode(
    config: ChannelImportProviderConfig,
    code: string,
  ): Promise<ProviderToken> {
    const parameters = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.callbackUrl,
    });
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
    if (config.provider === 'youtube') {
      parameters.set('client_id', config.clientId);
      parameters.set('client_secret', config.clientSecret);
    } else {
      headers.set(
        'Authorization',
        'Basic ' + Buffer.from(config.clientId + ':' + config.clientSecret, 'utf8').toString('base64'),
      );
    }

    const payload = await this.fetchJson(config.tokenEndpoint, {
      method: 'POST',
      headers,
      body: parameters,
    });
    const accessToken = readString(payload.access_token);
    if (!accessToken) {
      throw new ChannelImportError(
        'Could not connect ' + config.label + '. Please try again.',
        'authorization_failed',
        400,
      );
    }
    const refreshToken = readString(payload.refresh_token);
    const expiresIn = readPositiveNumber(payload.expires_in);
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      scopes: normalizeScopes(payload.scope, config.scopes),
      ...(expiresIn ? { expiresAt: new Date(this.now().getTime() + expiresIn * 1_000) } : {}),
    };
  }

  private async readSourceChannels(
    config: ChannelImportProviderConfig,
    accessToken: string,
  ): Promise<SourceChannel[]> {
    if (config.provider === 'youtube') return this.readYouTubeChannels(accessToken);
    return this.readVimeoChannel(accessToken);
  }

  private async readYouTubeChannels(accessToken: string): Promise<SourceChannel[]> {
    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('mine', 'true');
    url.searchParams.set('maxResults', '50');
    const payload = await this.fetchJson(url, {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const items = Array.isArray(payload.items) ? payload.items : [];
    return items.flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = readString(item.id);
      const snippet = isRecord(item.snippet) ? item.snippet : {};
      const title = readString(snippet.title);
      if (!id || !title) return [];
      const thumbnails = isRecord(snippet.thumbnails) ? snippet.thumbnails : {};
      const high = isRecord(thumbnails.high) ? thumbnails.high : {};
      const medium = isRecord(thumbnails.medium) ? thumbnails.medium : {};
      const thumbnailUrl = readHttpsUrl(high.url) ?? readHttpsUrl(medium.url);
      return [
        {
          id,
          title,
          sourceUrl: 'https://www.youtube.com/channel/' + encodeURIComponent(id),
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
        },
      ];
    });
  }

  private async readVimeoChannel(accessToken: string): Promise<SourceChannel[]> {
    const payload = await this.fetchJson('https://api.vimeo.com/me', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const uri = readString(payload.uri);
    const id = uri?.match(/^\/users\/([^/]+)$/)?.[1];
    const title = readString(payload.name);
    if (!id || !title) return [];
    const sourceUrl = readHttpsUrl(payload.link) ?? 'https://vimeo.com/' + encodeURIComponent(id);
    const pictures = isRecord(payload.pictures) ? payload.pictures : {};
    const sizes = Array.isArray(pictures.sizes) ? pictures.sizes : [];
    const thumbnailUrl = sizes
      .slice()
      .reverse()
      .map((item) => (isRecord(item) ? readHttpsUrl(item.link) : undefined))
      .find((value): value is string => Boolean(value));
    return [{ id, title, sourceUrl, ...(thumbnailUrl ? { thumbnailUrl } : {}) }];
  }

  private async fetchJson(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(input, {
        ...init,
        signal: AbortSignal.timeout(providerRequestTimeoutMs),
      });
    } catch {
      throw new ChannelImportError(
        'The provider did not respond. Please try again.',
        'authorization_failed',
        400,
      );
    }
    if (!response.ok) {
      throw new ChannelImportError(
        'The provider could not approve this connection.',
        'authorization_failed',
        400,
      );
    }
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!isRecord(payload)) {
      throw new ChannelImportError(
        'The provider returned an invalid response.',
        'authorization_failed',
        400,
      );
    }
    return payload;
  }

  private async requireUser(accessToken: string): Promise<AuthUser> {
    if (!accessToken.trim()) {
      throw new ChannelImportError('Authentication is required.', 'invalid_session', 401);
    }
    try {
      return await this.resolveUser(accessToken);
    } catch {
      throw new ChannelImportError('Authentication is required.', 'invalid_session', 401);
    }
  }
}

let sharedService: ChannelImportService | undefined;

export function getChannelImportService(): ChannelImportService {
  if (!sharedService) {
    sharedService = new ChannelImportService({
      store: new PostgresChannelImportStore(getW3dsDatabase()),
    });
  }
  return sharedService;
}

export function resetChannelImportServiceForTests(): void {
  sharedService = undefined;
}

export function createInMemoryChannelImportService(
  options: Omit<ChannelImportServiceOptions, 'store'> = {},
): { service: ChannelImportService; store: InMemoryChannelImportStore } {
  const store = new InMemoryChannelImportStore();
  return { service: new ChannelImportService({ ...options, store }), store };
}

function parseProvider(value: unknown): ChannelImportProvider {
  if (value === 'youtube' || value === 'vimeo') return value;
  throw new ChannelImportError('Choose YouTube or Vimeo.', 'invalid_provider', 400);
}

function providerLabel(provider: ChannelImportProvider): string {
  return provider === 'youtube' ? 'YouTube' : 'Vimeo';
}

function isValidState(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,256}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readHttpsUrl(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeScopes(value: unknown, fallback: readonly string[]): string[] {
  const scopes = typeof value === 'string' ? value.split(/[ ,]+/) : Array.isArray(value) ? value : [];
  const normalized = scopes.filter((scope): scope is string => typeof scope === 'string' && Boolean(scope));
  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback];
}
