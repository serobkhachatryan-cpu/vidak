import { randomUUID } from 'node:crypto';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  toBrowserAuthSession,
  type UpdateAuthProfileInput,
} from '@w3ds/auth';
import type { AuthDeviceSession } from '@w3ds/types';
import { getW3dsDatabase } from './db/client';
import {
  readRequiredW3dsServerConfig,
  resolveCookieSecurityConfig,
  resolveServerNodeEnv,
} from './server-config';
import {
  FilePersistedE2eW3dsAuthStore,
  resetFilePersistedE2eW3dsAuthStoreForTests,
} from './w3ds-auth-e2e-store';
import { W3dsAuthError } from './w3ds-auth-errors';
import {
  PostgresW3dsAuthStore,
  type StoredOffer,
  type StoredPlatformSession,
  type W3dsAuthStore,
} from './w3ds-auth-store';

export { W3dsAuthError } from './w3ds-auth-errors';
export type { W3dsAuthStore } from './w3ds-auth-store';
export { InMemoryW3dsAuthStore, PostgresW3dsAuthStore } from './w3ds-auth-store';

const crypto = globalThis.crypto;
const encoder = new TextEncoder();

const accessTokenLifetimeSeconds = 15 * 60;
const refreshTokenLifetimeSeconds = 7 * 24 * 60 * 60;
const defaultOfferLifetimeMs = 5 * 60 * 1000;
const requestTimeoutMs = 5_000;

export const w3dsAccessCookieName = 'w3ds_access';
export const w3dsRefreshCookieName = 'w3ds_refresh';

export interface W3dsAuthConfig {
  platformName: string;
  registryBaseUrl: string;
  jwtSecret: string;
  minimumWalletVersion?: string;
  offerLifetimeMs?: number;
}

export interface LoginOffer {
  offerId: string;
  sessionId: string;
  uri: string;
  expiresAt: string;
}

export type LoginOfferStatus =
  | { status: 'pending' }
  | { status: 'completed'; session: AuthSession }
  | { status: 'expired' }
  | { status: 'failed'; error: { code: string; message: string } };

export interface W3dsCallbackInput {
  w3id: string;
  session: string;
  signature: string;
  appVersion?: string;
}

export interface VerifiedW3dsIdentity {
  eName: string;
  eVaultId: string;
  eVaultUri: string;
}

export interface W3dsIdentityVerifier {
  verify(input: {
    eName: string;
    session: string;
    signature: string;
  }): Promise<VerifiedW3dsIdentity>;
}

/**
 * A verified arbitrary signing payload. Used by `w3ds://sign` flows; unlike
 * login it does not create a platform session or mutate an auth offer.
 */
export interface W3dsSignedPayloadInput {
  w3id: string;
  payload: string;
  signature: string;
}

interface PlatformTokenClaims {
  sub: string;
  sid: string;
  jti: string;
  typ: 'access' | 'refresh';
  iat: number;
  exp: number;
}

export interface W3dsAuthServiceOptions {
  config: W3dsAuthConfig;
  store: W3dsAuthStore;
  identityVerifier?: W3dsIdentityVerifier;
  now?: () => number;
}

/**
 * Platform-side W3DS authentication service.
 *
 * Next route handlers are its public surface. Registry and eVault traffic is
 * intentionally confined to the verifier, so no browser code sees protocol
 * service URLs, certificates, or public-key material.
 *
 * Durable offer/user/session state lives behind {@link W3dsAuthStore}. Runtime
 * production uses PostgreSQL; in-memory storage is only for explicit test
 * injection and is never a production fallback.
 */
export class W3dsAuthService {
  private readonly config: Required<Pick<W3dsAuthConfig, 'offerLifetimeMs'>> & W3dsAuthConfig;
  private readonly store: W3dsAuthStore;
  private readonly identityVerifier: W3dsIdentityVerifier;
  private readonly now: () => number;

  constructor(options: W3dsAuthServiceOptions) {
    this.config = {
      ...options.config,
      offerLifetimeMs: options.config.offerLifetimeMs ?? defaultOfferLifetimeMs,
    };
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.identityVerifier =
      options.identityVerifier ?? new RegistryW3dsIdentityVerifier(this.config.registryBaseUrl);
  }

  async createOffer(publicBaseUrl: string): Promise<LoginOffer> {
    const offerId = randomUUID();
    const sessionId = randomUUID();
    const expiresAt = this.now() + this.config.offerLifetimeMs;
    const offer = await this.store.createOffer({ id: offerId, sessionId, expiresAt });
    return this.toLoginOffer(offer, publicBaseUrl);
  }

  /**
   * Verifies a wallet signature over an application-owned one-time payload.
   * Registry/eVault traffic remains confined to the injected server verifier.
   */
  async verifySignedPayload(input: W3dsSignedPayloadInput): Promise<VerifiedW3dsIdentity> {
    if (!isEName(input.w3id) || !input.payload.trim() || !input.signature.trim()) {
      throw new W3dsAuthError('Signature verification failed.', 'invalid_signature', 401);
    }
    const identity = await this.identityVerifier.verify({
      eName: input.w3id,
      session: input.payload,
      signature: input.signature,
    });
    if (identity.eName !== input.w3id) {
      throw new W3dsAuthError('Signature verification failed.', 'invalid_signature', 401);
    }
    return identity;
  }

  /**
   * Reconstructs the public eID request for a pending offer. This supports
   * server-rendered login pages, where JavaScript may be unavailable, without
   * storing the URI itself or exposing any server credentials.
   */
  async getOfferForLogin(offerId: string, publicBaseUrl: string): Promise<LoginOffer | undefined> {
    const offer = await this.expireOfferIfNeeded(await this.store.getOfferById(offerId));
    if (!offer || (offer.status !== 'pending' && offer.status !== 'verifying')) return undefined;
    return this.toLoginOffer(offer, publicBaseUrl);
  }

  private toLoginOffer(offer: StoredOffer, publicBaseUrl: string): LoginOffer {
    const baseUrl = parseHttpUrl(publicBaseUrl, 'The platform public URL');
    // The eID Wallet protocol posts signed QR approvals to /api/auth and
    // navigates deep-link approvals through /deeplink-login. Keep the
    // callback path in lockstep with the wallet transport contract.
    const callbackUrl = new URL('/api/auth', baseUrl).toString();
    const offerUri = new URL('w3ds://auth');
    offerUri.searchParams.set('redirect', callbackUrl);
    offerUri.searchParams.set('session', offer.sessionId);
    offerUri.searchParams.set('platform', this.config.platformName);

    return {
      offerId: offer.id,
      sessionId: offer.sessionId,
      uri: offerUri.toString(),
      expiresAt: new Date(offer.expiresAt).toISOString(),
    };
  }

  /** Completes an offer and returns its id for the callback route to establish cookies. */
  async completeOffer(input: W3dsCallbackInput): Promise<string> {
    validateCallbackInput(input);
    const claimed = await this.store.claimOfferForVerification(input.session, this.now());
    if (!claimed) {
      const existing = await this.store.getOfferBySessionId(input.session);
      if (!existing) {
        throw new W3dsAuthError('Authentication session was not found.', 'invalid_session', 401);
      }
      if (existing.status === 'expired' || existing.expiresAt <= this.now()) {
        if (existing.status !== 'expired') {
          await this.store.markOfferExpired(existing.id);
        }
        throw new W3dsAuthError('Authentication session has expired.', 'expired_session', 401);
      }
      throw new W3dsAuthError('Authentication session was already used.', 'consumed_session', 401);
    }

    try {
      if (
        this.config.minimumWalletVersion &&
        !isAtLeastVersion(input.appVersion, this.config.minimumWalletVersion)
      ) {
        throw new W3dsAuthError(
          'The eID wallet version is not supported.',
          'unsupported_wallet',
          400,
        );
      }

      const identity = await this.identityVerifier.verify({
        eName: input.w3id,
        session: input.session,
        signature: input.signature,
      });
      if (identity.eName !== input.w3id) {
        throw new W3dsAuthError('Identity verification failed.', 'invalid_signature', 401);
      }

      const user = await this.findOrCreateUser(identity);
      const platformSession = await this.issueSession(user);
      await this.store.completeOffer(claimed.id, platformSession.id);
      return claimed.id;
    } catch (error) {
      const errorCode = error instanceof W3dsAuthError ? error.code : 'verification_failed';
      await this.store.failOffer(claimed.id, errorCode);
      if (error instanceof W3dsAuthError) throw error;
      throw new W3dsAuthError('Identity verification failed.', 'verification_failed', 401);
    }
  }

  async getOfferStatus(offerId: string): Promise<LoginOfferStatus> {
    const offer = await this.expireOfferIfNeeded(await this.store.getOfferById(offerId));
    if (!offer) {
      throw new W3dsAuthError('Authentication offer was not found.', 'invalid_offer', 404);
    }
    switch (offer.status) {
      case 'pending':
      case 'verifying':
        return { status: 'pending' };
      case 'expired':
        return { status: 'expired' };
      case 'failed':
        return {
          status: 'failed',
          error: {
            code: offer.errorCode ?? 'verification_failed',
            message: 'Authentication could not be verified.',
          },
        };
      case 'completed': {
        const session = offer.platformSessionId
          ? await this.store.getSessionById(offer.platformSessionId)
          : undefined;
        if (!session || session.revoked) {
          return {
            status: 'failed',
            error: { code: 'invalid_session', message: 'Authentication session is unavailable.' },
          };
        }
        // Browser JSON must not include JWTs; cookies are set separately.
        return {
          status: 'completed',
          session: toBrowserAuthSession(await this.toAuthSession(session, true)),
        };
      }
    }
  }

  /**
   * Returns access + refresh credentials for a same-origin route handler to set
   * as HTTP-only cookies. It must never be serialized into an API response.
   */
  async getOfferSessionForCookie(offerId: string): Promise<AuthSession> {
    const offer = await this.store.getOfferById(offerId);
    const session = offer?.platformSessionId
      ? await this.store.getSessionById(offer.platformSessionId)
      : undefined;
    if (offer?.status !== 'completed' || !session || session.revoked) {
      throw new W3dsAuthError('Authentication session is unavailable.', 'invalid_session', 401);
    }
    return this.toAuthSession(session, true);
  }

  async getSession(accessToken: string): Promise<AuthSession> {
    const platformSession = await this.getActiveSession(accessToken, 'access');
    return toBrowserAuthSession(await this.toAuthSession(platformSession, false));
  }

  /**
   * Rotates the platform session. The returned credentials are for cookie
   * setters only — route handlers must strip tokens before JSON serialization.
   */
  async refreshSession(refreshToken: string): Promise<AuthSession> {
    const claims = await this.verifyPlatformToken(refreshToken);
    if (claims.typ !== 'refresh') {
      throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
    }
    const platformSession = await this.store.getSessionById(claims.sid);
    if (
      !platformSession ||
      platformSession.revoked ||
      claims.jti !== platformSession.refreshJti ||
      claims.sub !== platformSession.user.id
    ) {
      throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
    }
    if (platformSession.refreshExpiresAt <= this.now()) {
      await this.store.revokeSession(platformSession.id);
      throw new W3dsAuthError('Authentication session has expired.', 'invalid_session', 401);
    }
    return this.toAuthSession(await this.issueSession(platformSession.user, platformSession), true);
  }

  async logout(accessToken?: string, refreshToken?: string): Promise<void> {
    const token = accessToken ?? refreshToken;
    if (!token) return;
    try {
      const claims = await this.verifyPlatformToken(token);
      await this.store.revokeSession(claims.sid);
    } catch {
      // Logout is idempotent. Client cookies are still cleared by the route.
    }
  }

  /**
   * Updates the authenticated user's local platform profile only.
   * Does not mutate eName, eVault metadata, email, or password.
   */
  async updateProfile(accessToken: string, input: UpdateAuthProfileInput): Promise<AuthUser> {
    const platformSession = await this.getActiveSession(accessToken, 'access');
    const displayName = validateProfileUpdateInput(input);
    return this.store.updateUserProfile({
      userId: platformSession.user.id,
      displayName,
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
    });
  }

  /** Lists only the authenticated user's active platform sessions. */
  async listSessions(accessToken: string): Promise<readonly AuthDeviceSession[]> {
    const platformSession = await this.getActiveSession(accessToken, 'access');
    const sessions = await this.store.listActiveSessionsByUserId(
      platformSession.user.id,
      this.now(),
    );
    return sessions.map((session) => toDeviceSession(session, platformSession.id));
  }

  /**
   * Revokes one of the authenticated user's sessions.
   * Rejects attempts to revoke the current session.
   */
  async revokeUserSession(
    accessToken: string,
    sessionId: string,
  ): Promise<readonly AuthDeviceSession[]> {
    const platformSession = await this.getActiveSession(accessToken, 'access');
    if (!sessionId.trim()) {
      throw new W3dsAuthError('Session not found.', 'invalid_session', 404);
    }
    if (sessionId === platformSession.id) {
      throw new W3dsAuthError('You cannot revoke your current session.', 'invalid_session', 400);
    }
    const target = await this.store.getSessionById(sessionId);
    if (
      !target ||
      target.revoked ||
      target.user.id !== platformSession.user.id ||
      target.refreshExpiresAt <= this.now()
    ) {
      throw new W3dsAuthError('Session not found.', 'invalid_session', 404);
    }
    await this.store.revokeSession(sessionId);
    const sessions = await this.store.listActiveSessionsByUserId(
      platformSession.user.id,
      this.now(),
    );
    return sessions.map((session) => toDeviceSession(session, platformSession.id));
  }

  private async expireOfferIfNeeded(
    offer: StoredOffer | undefined,
  ): Promise<StoredOffer | undefined> {
    if (!offer) return undefined;
    if (
      (offer.status === 'pending' || offer.status === 'verifying') &&
      offer.expiresAt <= this.now()
    ) {
      await this.store.markOfferExpired(offer.id);
      return { ...offer, status: 'expired' };
    }
    return offer;
  }

  private async findOrCreateUser(identity: VerifiedW3dsIdentity): Promise<AuthUser> {
    const displayName = identity.eName.slice(1).split('.')[0] || 'W3DS user';
    const candidate = createAuthUser({
      id: `w3ds_${randomUUID()}`,
      displayName,
      handle: displayName,
      roles: ['creator'],
      eName: identity.eName,
      eVaultId: identity.eVaultId,
      eVaultUri: identity.eVaultUri,
    });
    return this.store.findOrCreateUser(candidate);
  }

  private async issueSession(
    user: AuthUser,
    previousSession?: StoredPlatformSession,
  ): Promise<StoredPlatformSession> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const id = previousSession?.id ?? randomUUID();
    const accessJti = randomUUID();
    const refreshJti = randomUUID();
    const accessExpiresAt = (nowSeconds + accessTokenLifetimeSeconds) * 1000;
    const refreshExpiresAt = (nowSeconds + refreshTokenLifetimeSeconds) * 1000;

    if (previousSession) {
      const rotated = await this.store.rotateSession({
        sessionId: previousSession.id,
        expectedRefreshJti: previousSession.refreshJti,
        accessJti,
        refreshJti,
        accessExpiresAt,
        refreshExpiresAt,
      });
      if (!rotated) {
        throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
      }
      return rotated;
    }

    return this.store.createSession({
      id,
      user,
      accessJti,
      refreshJti,
      accessExpiresAt,
      refreshExpiresAt,
    });
  }

  private async toAuthSession(
    platformSession: StoredPlatformSession,
    includeRefreshToken = true,
  ): Promise<AuthSession> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const accessToken = await this.createPlatformToken({
      sub: platformSession.user.id,
      sid: platformSession.id,
      jti: platformSession.accessJti,
      typ: 'access',
      iat: nowSeconds,
      exp: Math.floor(platformSession.accessExpiresAt / 1000),
    });
    const refreshToken = await this.createPlatformToken({
      sub: platformSession.user.id,
      sid: platformSession.id,
      jti: platformSession.refreshJti,
      typ: 'refresh',
      iat: nowSeconds,
      exp: Math.floor(platformSession.refreshExpiresAt / 1000),
    });
    return {
      user: platformSession.user,
      provider: 'w3ds',
      tokens: {
        accessToken,
        ...(includeRefreshToken ? { refreshToken } : {}),
        expiresAt: new Date(platformSession.accessExpiresAt).toISOString(),
      },
    };
  }

  private async getActiveSession(
    token: string,
    expectedType: PlatformTokenClaims['typ'],
  ): Promise<StoredPlatformSession> {
    const claims = await this.verifyPlatformToken(token);
    if (claims.typ !== expectedType) {
      throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
    }
    const session = await this.store.getSessionById(claims.sid);
    const expectedJti = expectedType === 'access' ? session?.accessJti : session?.refreshJti;
    if (
      !session ||
      session.revoked ||
      claims.jti !== expectedJti ||
      claims.sub !== session.user.id
    ) {
      throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
    }
    return session;
  }

  private async createPlatformToken(claims: PlatformTokenClaims): Promise<string> {
    const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64UrlEncode(JSON.stringify(claims));
    const signingInput = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(encoder.encode(this.config.jwtSecret)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      toArrayBuffer(encoder.encode(signingInput)),
    );
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  private async verifyPlatformToken(token: string): Promise<PlatformTokenClaims> {
    const [encodedHeader, encodedPayload, encodedSignature, ...rest] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature || rest.length > 0) {
      throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
    }
    const header = parseJson<{ alg?: string; typ?: string }>(encodedHeader);
    const claims = parseJson<Partial<PlatformTokenClaims>>(encodedPayload);
    if (header.alg !== 'HS256' || header.typ !== 'JWT' || !isPlatformTokenClaims(claims)) {
      throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
    }
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(encoder.encode(this.config.jwtSecret)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      toArrayBuffer(base64UrlDecode(encodedSignature)),
      toArrayBuffer(encoder.encode(`${encodedHeader}.${encodedPayload}`)),
    );
    if (!valid || claims.exp <= Math.floor(this.now() / 1000)) {
      throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
    }
    return claims;
  }
}

/** Verifies eID wallet signatures against Registry-attested eVault keys. */
export class RegistryW3dsIdentityVerifier implements W3dsIdentityVerifier {
  private readonly registryBaseUrl: string;

  constructor(registryBaseUrl: string) {
    this.registryBaseUrl = parseHttpUrl(registryBaseUrl, 'W3DS Registry URL').toString();
  }

  async verify(input: {
    eName: string;
    session: string;
    signature: string;
  }): Promise<VerifiedW3dsIdentity> {
    if (!isEName(input.eName)) {
      throw new W3dsAuthError('Identity verification failed.', 'invalid_signature', 401);
    }
    const registry = parseRegistryResolution(
      await getJson(
        new URL(`/resolve?w3id=${encodeURIComponent(input.eName)}`, this.registryBaseUrl),
      ),
    );
    if (registry.eName !== input.eName) {
      throw new W3dsAuthError('Identity verification failed.', 'invalid_signature', 401);
    }
    const certificates = parseWhoisResponse(
      await getJson(new URL('/whois', registry.eVaultUri), { 'X-ENAME': input.eName }),
    );
    const jwks = parseJwks(await getJson(new URL('/.well-known/jwks.json', this.registryBaseUrl)));
    const certificatesForIdentity = await Promise.all(
      certificates.map((certificate) =>
        verifyKeyBindingCertificate(certificate, jwks, input.eName),
      ),
    );
    const payload = toArrayBuffer(encoder.encode(input.session));
    const signature = normalizeEcdsaSignature(decodeSignature(input.signature));
    const verified = await Promise.any(
      certificatesForIdentity.map(async (certificate) => {
        const publicKey = await importW3dsPublicKey(certificate.publicKey);
        const valid = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          toArrayBuffer(signature),
          payload,
        );
        if (!valid) throw new Error('Signature does not match this key.');
      }),
    ).then(
      () => true,
      () => false,
    );
    if (!verified) {
      throw new W3dsAuthError('Identity verification failed.', 'invalid_signature', 401);
    }
    return {
      eName: registry.eName,
      eVaultId: registry.eVaultId,
      eVaultUri: registry.eVaultUri,
    };
  }
}

interface RegistryResolution {
  eName: string;
  eVaultId: string;
  eVaultUri: string;
}

interface RegistryJwk {
  kid?: string;
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  use?: string;
  alg?: string;
}

interface KeyBindingCertificate {
  eName: string;
  publicKey: string;
  exp: number;
}

function validateCallbackInput(input: W3dsCallbackInput) {
  if (!input.w3id?.trim() || !input.session?.trim() || !input.signature?.trim()) {
    throw new W3dsAuthError('Missing required authentication fields.', 'validation_failed', 400);
  }
  if (!isEName(input.w3id)) {
    throw new W3dsAuthError('The W3DS identity is invalid.', 'validation_failed', 400);
  }
}

const maxDisplayNameLength = 50;

function validateProfileUpdateInput(input: UpdateAuthProfileInput): string {
  if (typeof input.displayName !== 'string') {
    throw new W3dsAuthError('Display name is required.', 'validation_failed', 400);
  }
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new W3dsAuthError('Display name is required.', 'validation_failed', 400);
  }
  if (displayName.length > maxDisplayNameLength) {
    throw new W3dsAuthError(
      'Display name must be 50 characters or fewer.',
      'validation_failed',
      400,
    );
  }
  if (input.avatarUrl !== undefined && input.avatarUrl !== null) {
    if (typeof input.avatarUrl !== 'string' || !isHttpUrl(input.avatarUrl)) {
      throw new W3dsAuthError('Avatar URL is invalid.', 'validation_failed', 400);
    }
  }
  return displayName;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function toDeviceSession(
  session: StoredPlatformSession,
  currentSessionId: string,
): AuthDeviceSession {
  return {
    id: session.id,
    deviceName: 'Vidak session',
    lastActiveAt: new Date(session.updatedAt).toISOString(),
    createdAt: new Date(session.createdAt).toISOString(),
    current: session.id === currentSessionId,
  };
}

function isEName(value: string): boolean {
  return /^@[a-z0-9][a-z0-9.-]*$/i.test(value);
}

function isAtLeastVersion(actual: string | undefined, minimum: string): boolean {
  if (!actual) return false;
  const parse = (value: string) => {
    if (!/^\d+(?:\.\d+){0,2}$/.test(value)) return undefined;
    return value.split('.').map(Number);
  };
  const parsedActual = parse(actual);
  const parsedMinimum = parse(minimum);
  if (!parsedActual || !parsedMinimum) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = parsedActual[index] ?? 0;
    const right = parsedMinimum[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function isPlatformTokenClaims(value: Partial<PlatformTokenClaims>): value is PlatformTokenClaims {
  return (
    typeof value.sub === 'string' &&
    typeof value.sid === 'string' &&
    typeof value.jti === 'string' &&
    (value.typ === 'access' || value.typ === 'refresh') &&
    typeof value.iat === 'number' &&
    typeof value.exp === 'number'
  );
}

function parseHttpUrl(value: string, label: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('Unsupported protocol');
    return url;
  } catch {
    throw new W3dsAuthError(`${label} must be an HTTP(S) URL.`, 'configuration_error', 503);
  }
}

async function getJson(url: URL, headers?: HeadersInit): Promise<unknown> {
  let response: Response;
  try {
    const init: RequestInit = {
      cache: 'no-store',
      signal: AbortSignal.timeout(requestTimeoutMs),
      ...(headers ? { headers } : {}),
    };
    response = await fetch(url, init);
  } catch {
    throw new W3dsAuthError('Identity verification failed.', 'verification_failed', 401);
  }
  if (!response.ok) {
    throw new W3dsAuthError('Identity verification failed.', 'verification_failed', 401);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new W3dsAuthError('Identity verification failed.', 'verification_failed', 401);
  }
}

function parseRegistryResolution(value: unknown): RegistryResolution {
  if (!isRecord(value) || typeof value.ename !== 'string' || typeof value.evault !== 'string') {
    throw new W3dsAuthError('Identity verification failed.', 'verification_failed', 401);
  }
  const eVaultUri = typeof value.uri === 'string' ? value.uri : undefined;
  if (!eVaultUri) {
    throw new W3dsAuthError('Identity verification failed.', 'verification_failed', 401);
  }
  return {
    eName: value.ename,
    eVaultId: value.evault,
    eVaultUri: parseHttpUrl(eVaultUri, 'Resolved eVault URL').toString(),
  };
}

function parseWhoisResponse(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.keyBindingCertificates) ||
    !value.keyBindingCertificates.every((certificate) => typeof certificate === 'string')
  ) {
    throw new W3dsAuthError('Identity verification failed.', 'verification_failed', 401);
  }
  return value.keyBindingCertificates;
}

function parseJwks(value: unknown): readonly RegistryJwk[] {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new W3dsAuthError('Identity verification failed.', 'verification_failed', 401);
  }
  return value.keys.filter(isRecord);
}

async function verifyKeyBindingCertificate(
  token: string,
  jwks: readonly RegistryJwk[],
  expectedEName: string,
): Promise<KeyBindingCertificate> {
  const [encodedHeader, encodedPayload, encodedSignature, ...rest] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || rest.length > 0) {
    throw new Error('Invalid certificate.');
  }
  const header = parseJson<{ alg?: string; kid?: string }>(encodedHeader);
  const payload = parseJson<{ ename?: string; publicKey?: string; exp?: number }>(encodedPayload);
  const jwk = jwks.find((candidate) => candidate.kid === header.kid);
  if (
    header.alg !== 'ES256' ||
    !jwk ||
    payload.ename !== expectedEName ||
    typeof payload.publicKey !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error('Invalid certificate.');
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(base64UrlDecode(encodedSignature)),
    toArrayBuffer(encoder.encode(`${encodedHeader}.${encodedPayload}`)),
  );
  if (!valid) throw new Error('Invalid certificate.');
  return { eName: payload.ename, publicKey: payload.publicKey, exp: payload.exp };
}

async function importW3dsPublicKey(encodedKey: string): Promise<CryptoKey> {
  const bytes = decodeMultibase(encodedKey);
  if (bytes.length === 65 && bytes[0] === 4) {
    return crypto.subtle.importKey(
      'raw',
      toArrayBuffer(bytes),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  }
  return crypto.subtle.importKey(
    'spki',
    toArrayBuffer(bytes),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

function decodeSignature(signature: string): Uint8Array {
  // Software wallet signatures are base64 and may legitimately begin with
  // `z`. Prefer a valid base64 form before treating that prefix as multibase.
  let base64: Uint8Array | undefined;
  try {
    base64 = decodeBase64(signature);
  } catch {
    // A base58 or explicitly prefixed encoding is handled below.
  }

  let base58: Uint8Array | undefined;
  if (
    signature.startsWith('z') &&
    /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(signature.slice(1))
  ) {
    try {
      base58 = decodeBase58(signature.slice(1));
    } catch {
      // Report the normal validation failure if no supported form succeeds.
    }
  }

  if (base58 && looksLikeDerEcdsaSignature(base58)) return base58;
  if (base64 && looksLikeDerEcdsaSignature(base64)) return base64;
  if (base64) return base64;
  if (base58) return base58;

  if (signature.startsWith('m')) return decodeBase64(signature.slice(1));
  if (signature.startsWith('f')) return hexDecode(signature.slice(1));
  throw new Error('Unsupported signature encoding.');
}

function decodeMultibase(value: string): Uint8Array {
  const prefix = value[0];
  const content = value.slice(1);
  // The reference eID software wallet writes public keys as `z` followed by
  // hex-encoded SPKI bytes, while standard multibase uses base58btc. Support
  // both representations before importing the P-256 public key.
  if (prefix === 'z')
    return /^[a-f\d]+$/i.test(content) ? hexDecode(content) : decodeBase58(content);
  if (prefix === 'm') return decodeBase64(content);
  if (prefix === 'f') return hexDecode(content);
  throw new Error('Unsupported public key encoding.');
}

/** Web Crypto expects the IEEE P1363 `r || s` signature form for P-256. */
function normalizeEcdsaSignature(signature: Uint8Array): Uint8Array {
  return looksLikeDerEcdsaSignature(signature) ? derEcdsaToRaw(signature, 32) : signature;
}

function looksLikeDerEcdsaSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) return false;
  if (bytes[2] !== 0x02) return false;
  const rLength = bytes[3] ?? 0;
  const sTagIndex = 4 + rLength;
  if (sTagIndex + 2 > bytes.length || bytes[sTagIndex] !== 0x02) return false;
  const sLength = bytes[sTagIndex + 1] ?? 0;
  return sTagIndex + 2 + sLength === bytes.length;
}

function derEcdsaToRaw(bytes: Uint8Array, scalarLength: number): Uint8Array {
  if (!looksLikeDerEcdsaSignature(bytes)) throw new Error('Invalid DER ECDSA signature.');
  const rLength = bytes[3] ?? 0;
  const r = bytes.slice(4, 4 + rLength);
  const sLengthIndex = 5 + rLength;
  const sLength = bytes[sLengthIndex] ?? 0;
  const s = bytes.slice(sLengthIndex + 1, sLengthIndex + 1 + sLength);
  const raw = new Uint8Array(scalarLength * 2);

  const writeScalar = (value: Uint8Array, offset: number) => {
    let firstSignificant = 0;
    while (firstSignificant < value.length - 1 && value[firstSignificant] === 0) {
      firstSignificant += 1;
    }
    const normalized = value.slice(firstSignificant);
    if (normalized.length > scalarLength) throw new Error('Invalid ECDSA scalar length.');
    raw.set(normalized, offset + scalarLength - normalized.length);
  };

  writeScalar(r, 0);
  writeScalar(s, scalarLength);
  return raw;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) throw new Error('Invalid base64 value.');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(normalized, 'base64'));
}

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value.');
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}

function hexDecode(value: string): Uint8Array {
  if (!/^[a-f\d]+$/i.test(value) || value.length % 2 !== 0) throw new Error('Invalid hex value.');
  return new Uint8Array(Buffer.from(value, 'hex'));
}

function decodeBase58(value: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [];
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid base58 value.');
    let carry = digit;
    for (let index = bytes.length - 1; index >= 0; index -= 1) {
      const next = (bytes[index] ?? 0) * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.unshift(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes.length > 0 ? bytes : [0]);
}

function parseJson<T>(encoded: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as T;
  } catch {
    throw new W3dsAuthError('Authentication token is invalid.', 'invalid_session', 401);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

let service: W3dsAuthService | undefined;

/**
 * Non-production e2e stub: in-memory offers/sessions + identity verifier that
 * never calls Registry/eVault. Hard-disabled when NODE_ENV=production.
 */
export function isW3dsAuthE2eStubEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV !== 'production' && env.W3DS_AUTH_E2E_STUB === '1';
}

function createE2eStubAuthService(
  env: Record<string, string | undefined> = process.env,
): W3dsAuthService {
  const jwtSecret = env.W3DS_AUTH_JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new W3dsAuthError(
      'W3DS_AUTH_E2E_STUB requires W3DS_AUTH_JWT_SECRET with at least 32 characters.',
      'configuration_error',
      503,
    );
  }
  return new W3dsAuthService({
    config: {
      platformName: env.W3DS_AUTH_PLATFORM_NAME?.trim() || 'vidak',
      registryBaseUrl: env.W3DS_REGISTRY_BASE_URL?.trim() || 'http://127.0.0.1:9',
      jwtSecret,
    },
    store: new FilePersistedE2eW3dsAuthStore(),
    identityVerifier: {
      async verify({ eName }) {
        if (!eName.startsWith('@') || !eName.includes('.')) {
          throw new W3dsAuthError('Identity verification failed.', 'invalid_signature', 401);
        }
        return {
          eName,
          eVaultId: 'e2e-evault',
          eVaultUri: 'http://127.0.0.1:9/evault',
        };
      },
    },
  });
}

export function getW3dsAuthService(): W3dsAuthService {
  if (isW3dsAuthE2eStubEnabled()) {
    const globalState = globalThis as typeof globalThis & {
      __vidakW3dsE2eAuthService?: W3dsAuthService;
    };
    // Survive Next.js module re-evaluation so offer + continue share one store.
    globalState.__vidakW3dsE2eAuthService ??= createE2eStubAuthService();
    return globalState.__vidakW3dsE2eAuthService;
  }

  service ??= new W3dsAuthService({
    config: readW3dsAuthConfig(),
    store: new PostgresW3dsAuthStore(getW3dsDatabase()),
  });
  return service;
}

/** Test helper to clear the process singleton between cases. */
export function resetW3dsAuthServiceForTests(): void {
  service = undefined;
  const globalState = globalThis as typeof globalThis & {
    __vidakW3dsE2eAuthService?: W3dsAuthService;
  };
  delete globalState.__vidakW3dsE2eAuthService;
  resetFilePersistedE2eW3dsAuthStoreForTests();
}

export function readW3dsAuthConfig(
  env: Record<string, string | undefined> = process.env,
): W3dsAuthConfig {
  try {
    const config = readRequiredW3dsServerConfig(env);
    return {
      platformName: config.platformName,
      registryBaseUrl: config.registryBaseUrl,
      jwtSecret: config.jwtSecret,
      ...(config.minimumWalletVersion ? { minimumWalletVersion: config.minimumWalletVersion } : {}),
    };
  } catch (error) {
    throw new W3dsAuthError(
      error instanceof Error ? error.message : 'W3DS authentication is not configured.',
      'configuration_error',
      503,
    );
  }
}

export function getBearerToken(headers: Headers): string | undefined {
  const authorization = headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length).trim();
  return token || undefined;
}

export interface W3dsCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}

/** Cookie attribute defaults for W3DS session credentials. */
export function w3dsCookieOptions(
  maxAge: number,
  secure = resolveCookieSecurityConfig(resolveServerNodeEnv()).secure,
): W3dsCookieOptions {
  const base = resolveCookieSecurityConfig(resolveServerNodeEnv());
  return {
    httpOnly: base.httpOnly,
    sameSite: base.sameSite,
    secure,
    path: base.path,
    maxAge,
  };
}

/**
 * Applies HttpOnly session cookies from a credential-bearing AuthSession.
 * Callers must not put `session.tokens` into the JSON body.
 *
 * `secure` must reflect the browser connection (see
 * `resolveRequestCookieSecure`). Max-Age must stay > 0 for a live session —
 * Max-Age=0 is a delete-cookie and drops the handoff before `/auth/handoff`.
 */
export function applyW3dsSessionCookies(
  cookies: {
    set(name: string, value: string, options: W3dsCookieOptions): void;
  },
  session: AuthSession,
  secure = resolveCookieSecurityConfig(resolveServerNodeEnv()).secure,
): void {
  const accessToken = session.tokens.accessToken;
  if (!accessToken) {
    throw new W3dsAuthError('Authentication session is unavailable.', 'invalid_session', 401);
  }
  const remainingSeconds = Math.floor(
    (new Date(session.tokens.expiresAt).getTime() - Date.now()) / 1000,
  );
  // Wall-clock skew (or a frozen test clock) can make remainingSeconds <= 0
  // even though the JWT is still valid under the auth service clock. Never
  // mint Max-Age=0 here — that deletes w3ds_access before handoff.
  const accessMaxAge = remainingSeconds > 0 ? remainingSeconds : accessTokenLifetimeSeconds;
  cookies.set(w3dsAccessCookieName, accessToken, w3dsCookieOptions(accessMaxAge, secure));
  if (session.tokens.refreshToken) {
    cookies.set(
      w3dsRefreshCookieName,
      session.tokens.refreshToken,
      w3dsCookieOptions(refreshTokenLifetimeSeconds, secure),
    );
  }
}

/** Clears W3DS session cookies on logout. */
export function clearW3dsSessionCookies(
  cookies: {
    set(name: string, value: string, options: W3dsCookieOptions): void;
  },
  secure = resolveCookieSecurityConfig(resolveServerNodeEnv()).secure,
): void {
  cookies.set(w3dsAccessCookieName, '', w3dsCookieOptions(0, secure));
  cookies.set(w3dsRefreshCookieName, '', w3dsCookieOptions(0, secure));
}
