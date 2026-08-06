/**
 * Shared request-boundary helpers for cookie-authenticated mutations.
 * Bearer-authenticated server/API clients skip browser-origin validation.
 */

import type { NextRequest } from 'next/server';
import {
  loadServerSecurityConfig,
  normalizeOrigin,
  type ServerSecurityConfig,
} from './server-config';
import { W3dsAuthError } from './w3ds-auth-errors';

export type MutationRequestLike = {
  headers: Headers;
  nextUrl?: { origin: string };
  url: string;
};

/**
 * Enforces trusted Origin/Referer for cookie-based state-changing requests.
 * Calls with `Authorization: Bearer` continue without browser-origin checks.
 */
export function assertTrustedMutationOrigin(
  request: MutationRequestLike,
  config: ServerSecurityConfig = loadServerSecurityConfig(),
): void {
  if (hasBearerAuthorization(request.headers)) {
    return;
  }

  const requestOrigin = resolveRequestOrigin(request);
  const candidate = readRequestOriginCandidate(request.headers);
  if (!candidate) {
    throw new W3dsAuthError(
      'Trusted request origin is required for cookie-authenticated mutations.',
      'untrusted_origin',
      403,
    );
  }

  if (!isTrustedMutationOrigin(candidate, requestOrigin, config.trustedOrigins)) {
    throw new W3dsAuthError(
      'Request origin is not trusted for cookie-authenticated mutations.',
      'untrusted_origin',
      403,
    );
  }
}

/**
 * Validates the cookie-backed session rotation endpoint.
 *
 * Browser `fetch` normally includes `Origin` for this POST, but some embedded
 * webviews omit both Origin and Referer for a same-origin credential refresh.
 * Accept that narrow browser-only case when Fetch Metadata confirms it is a
 * same-origin CORS fetch. Cross-site requests retain the regular fail-closed
 * Origin/Referer requirement.
 */
export function assertTrustedSessionRefreshOrigin(
  request: MutationRequestLike,
  config: ServerSecurityConfig = loadServerSecurityConfig(),
): void {
  try {
    assertTrustedMutationOrigin(request, config);
  } catch (error) {
    if (
      error instanceof W3dsAuthError &&
      error.code === 'untrusted_origin' &&
      !readRequestOriginCandidate(request.headers) &&
      request.headers.get('sec-fetch-site') === 'same-origin' &&
      request.headers.get('sec-fetch-mode') === 'cors'
    ) {
      return;
    }
    throw error;
  }
}

export function isTrustedMutationOrigin(
  candidateOrigin: string,
  requestOrigin: string | undefined,
  configuredTrustedOrigins: readonly string[],
): boolean {
  const candidate = normalizeOrigin(candidateOrigin);
  if (!candidate) return false;

  if (requestOrigin && candidate === requestOrigin) return true;
  return configuredTrustedOrigins.includes(candidate);
}

export function readRequestOriginCandidate(headers: Headers): string | undefined {
  const originHeader = normalizeOrigin(headers.get('origin'));
  if (originHeader) return originHeader;

  const referer = headers.get('referer');
  if (!referer) return undefined;
  return normalizeOrigin(referer);
}

export function resolveRequestOrigin(request: MutationRequestLike): string | undefined {
  if (request.nextUrl?.origin) {
    return normalizeOrigin(request.nextUrl.origin);
  }
  return normalizeOrigin(request.url);
}

/** True when a response would enable credentialed cross-origin browser access. */
export function responseAllowsCredentialedCors(headers: Headers): boolean {
  const allowOrigin = headers.get('access-control-allow-origin');
  if (!allowOrigin || allowOrigin === 'null') return false;
  const allowCredentials = headers.get('access-control-allow-credentials');
  return allowCredentials?.toLowerCase() === 'true';
}

/** Ensures API JSON errors do not embed private server configuration. */
export function assertSafePublicErrorPayload(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  const forbidden = [
    'W3DS_AUTH_JWT_SECRET',
    'DATABASE_URL',
    'jwtSecret',
    'postgresql://',
    'postgres://',
  ];
  for (const needle of forbidden) {
    if (serialized.includes(needle)) {
      throw new Error(`Public error payload must not reveal private configuration (${needle}).`);
    }
  }
}

/** Convenience for route handlers that map security errors like other W3DS auth errors. */
export function mutationSecurityErrorResponse(error: unknown): {
  body: { error: { code: string; message: string } };
  status: number;
} | null {
  if (error instanceof W3dsAuthError && error.code === 'untrusted_origin') {
    return {
      body: { error: { code: error.code, message: error.message } },
      status: error.status,
    };
  }
  return null;
}

/** Narrow NextRequest helper so call sites stay typed without casting. */
export function assertTrustedMutationOriginForRequest(
  request: NextRequest,
  config?: ServerSecurityConfig,
): void {
  assertTrustedMutationOrigin(request, config);
}

function hasBearerAuthorization(headers: Headers): boolean {
  const authorization = headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  return Boolean(authorization.slice('Bearer '.length).trim());
}
