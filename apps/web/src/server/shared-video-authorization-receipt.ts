/// <reference path="./server-only-module.d.ts" />
/**
 * Cross-replica authorization receipts for a just-authorized shared video.
 *
 * A receipt is deliberately not an authorization grant. It is a short-lived,
 * viewer-and-stream-bound hint that lets a different application replica trust
 * a completed interactive warmup without repeating the expensive source ACL
 * probe. The receiving route must still validate the W3DS session and stream
 * grant before using it.
 *
 * The signed payload contains only keyed, non-reversible fingerprints. It
 * never contains an eName, stream ID, source URL, or eVault identifier.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import 'server-only';

const receiptVersion = 'svr1';
const receiptPayloadVersion = 1;
const keyDomain = 'vidak.shared-video-authorization-receipt.key.v1';
const signatureDomain = 'vidak.shared-video-authorization-receipt.signature.v1';
const viewerFingerprintDomain = 'vidak.shared-video-authorization-receipt.viewer.v1';
const streamFingerprintDomain = 'vidak.shared-video-authorization-receipt.stream.v1';
const maxReceiptLength = 1_024;
const maxPayloadBytes = 512;
const nonceBytes = 16;
const clockSkewMs = 5_000;
const minimumSecretLength = 32;

/** Short enough that a warmup hint cannot become a durable authorization. */
export const sharedVideoAuthorizationReceiptTtlSeconds = 45;
export const sharedVideoAuthorizationReceiptTtlMs =
  sharedVideoAuthorizationReceiptTtlSeconds * 1_000;

/**
 * Scoped to the API player routes, including eVault playback, recording-ticket
 * creation, and the legacy Meshenger player. `__Secure-` prevents a browser
 * from accepting the cookie without its required Secure attribute.
 */
export const sharedVideoAuthorizationReceiptCookieName =
  '__Secure-vidak-shared-video-authorization';
export const sharedVideoAuthorizationReceiptCookiePath = '/api';

export interface SharedVideoAuthorizationReceiptCookieOptions {
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: typeof sharedVideoAuthorizationReceiptCookiePath;
  maxAge: typeof sharedVideoAuthorizationReceiptTtlSeconds;
}

export interface SharedVideoAuthorizationReceiptInput {
  viewerEName: string;
  streamId: string;
  /** Defaults to process.env so production must provide the W3DS secret. */
  env?: Record<string, string | undefined>;
  /** Injectable only for deterministic tests. Milliseconds since the epoch. */
  now?: number;
}

export interface VerifySharedVideoAuthorizationReceiptInput
  extends SharedVideoAuthorizationReceiptInput {
  receipt: string | null | undefined;
}

interface ReceiptClaims {
  v: 1;
  i: number;
  e: number;
  n: string;
  u: string;
  s: string;
}

/**
 * Fails closed when the mandatory secret is absent or too short. Callers
 * should surface configuration failure through their normal readiness path,
 * never by logging a receipt or its bound identifiers.
 */
export class SharedVideoAuthorizationReceiptConfigurationError extends Error {
  constructor() {
    super(
      `Shared-video authorization receipts require W3DS_AUTH_JWT_SECRET with at least ${minimumSecretLength} characters.`,
    );
  }
}

/**
 * Creates an opaque, 45-second proof that this exact viewer just authorized
 * this exact opaque stream. It is safe to place in the receipt cookie below.
 */
export function mintSharedVideoAuthorizationReceipt(
  input: SharedVideoAuthorizationReceiptInput,
): string {
  const key = receiptKey(input.env ?? process.env);
  const viewerEName = requireViewerEName(input.viewerEName);
  const streamId = requireOpaqueStreamId(input.streamId);
  const issuedAt = requireNow(input.now ?? Date.now());
  const claims: ReceiptClaims = {
    v: receiptPayloadVersion,
    i: issuedAt,
    e: issuedAt + sharedVideoAuthorizationReceiptTtlMs,
    n: randomBytes(nonceBytes).toString('base64url'),
    u: fingerprint(key, viewerFingerprintDomain, viewerEName),
    s: fingerprint(key, streamFingerprintDomain, streamId),
  };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${receiptVersion}.${encoded}.${signature(key, encoded)}`;
}

/**
 * Verifies the opaque receipt strictly and fails closed for malformed,
 * expired, tampered, or differently bound values. Configuration failures are
 * intentionally thrown instead of being misreported as an authorization deny.
 */
export function verifySharedVideoAuthorizationReceipt(
  input: VerifySharedVideoAuthorizationReceiptInput,
): boolean {
  const key = receiptKey(input.env ?? process.env);
  const viewerEName = validViewerEName(input.viewerEName);
  const streamId = validOpaqueStreamId(input.streamId);
  const now = validNow(input.now ?? Date.now());
  if (!viewerEName || !streamId || now === undefined) return false;

  const parsed = parseReceipt(input.receipt, key);
  if (!parsed) return false;
  const { claims } = parsed;

  // The exact issued-to-expiry interval is part of the signed canonical
  // payload, so a receipt can never become a long-lived token.
  if (
    claims.e - claims.i !== sharedVideoAuthorizationReceiptTtlMs ||
    claims.i > now + clockSkewMs ||
    claims.e <= now
  ) {
    return false;
  }

  const expectedViewer = fingerprint(key, viewerFingerprintDomain, viewerEName);
  const expectedStream = fingerprint(key, streamFingerprintDomain, streamId);
  return constantTimeEqual(claims.u, expectedViewer) && constantTimeEqual(claims.s, expectedStream);
}

/** Cookie attributes for writing the opaque receipt from a Route Handler. */
export function sharedVideoAuthorizationReceiptCookieOptions(): SharedVideoAuthorizationReceiptCookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: sharedVideoAuthorizationReceiptCookiePath,
    maxAge: sharedVideoAuthorizationReceiptTtlSeconds,
  };
}

function parseReceipt(
  value: string | null | undefined,
  key: Buffer,
): { claims: ReceiptClaims } | undefined {
  if (!value || value.length > maxReceiptLength) return undefined;
  const [version, encoded, providedSignature, ...rest] = value.split('.');
  if (
    version !== receiptVersion ||
    !encoded ||
    !providedSignature ||
    rest.length !== 0 ||
    !isBase64Url(encoded) ||
    !isBase64Url(providedSignature)
  ) {
    return undefined;
  }

  const expectedSignature = signature(key, encoded);
  if (!constantTimeEqual(providedSignature, expectedSignature)) return undefined;

  const payload = strictBase64UrlDecode(encoded);
  if (!payload || payload.byteLength > maxPayloadBytes) return undefined;
  const claims = parseCanonicalClaims(payload);
  return claims ? { claims } : undefined;
}

function parseCanonicalClaims(payload: Buffer): ReceiptClaims | undefined {
  const text = payload.toString('utf8');
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 6 ||
    !['v', 'i', 'e', 'n', 'u', 's'].every((key) => Object.hasOwn(record, key)) ||
    record.v !== receiptPayloadVersion ||
    !isSafeEpochMilliseconds(record.i) ||
    !isSafeEpochMilliseconds(record.e) ||
    !isBase64UrlString(record.n, nonceBytes) ||
    !isBase64UrlString(record.u, 32) ||
    !isBase64UrlString(record.s, 32)
  ) {
    return undefined;
  }

  const claims: ReceiptClaims = {
    v: receiptPayloadVersion,
    i: record.i,
    e: record.e,
    n: record.n,
    u: record.u,
    s: record.s,
  };
  // JSON.stringify in the mint function gives us one canonical wire form.
  // Requiring it here rejects duplicate keys, extra whitespace, and fields.
  return JSON.stringify(claims) === text ? claims : undefined;
}

function receiptKey(env: Record<string, string | undefined>): Buffer {
  const secret = env.W3DS_AUTH_JWT_SECRET;
  if (!secret || secret.length < minimumSecretLength) {
    throw new SharedVideoAuthorizationReceiptConfigurationError();
  }
  return createHmac('sha256', secret).update(keyDomain, 'utf8').digest();
}

function signature(key: Buffer, encoded: string): string {
  return createHmac('sha256', key)
    .update(signatureDomain, 'utf8')
    .update('\u0000', 'utf8')
    .update(encoded, 'utf8')
    .digest('base64url');
}

function fingerprint(key: Buffer, domain: string, value: string): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\u0000', 'utf8')
    .update(value, 'utf8')
    .digest('base64url');
}

function constantTimeEqual(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    valueBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(valueBytes, expectedBytes)
  );
}

function strictBase64UrlDecode(value: string): Buffer | undefined {
  if (!isBase64Url(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength > 0 && decoded.toString('base64url') === value ? decoded : undefined;
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function isBase64UrlString(value: unknown, byteLength: number): value is string {
  if (typeof value !== 'string') return false;
  const decoded = strictBase64UrlDecode(value);
  return decoded?.byteLength === byteLength;
}

function requireViewerEName(value: string): string {
  const normalized = validViewerEName(value);
  if (!normalized) throw new TypeError('A valid viewer eName is required.');
  return normalized;
}

function validViewerEName(value: unknown): string | undefined {
  return typeof value === 'string' && /^@[^\s@/]{1,255}$/.test(value) ? value : undefined;
}

function requireOpaqueStreamId(value: string): string {
  const normalized = validOpaqueStreamId(value);
  if (!normalized) throw new TypeError('A valid opaque stream ID is required.');
  return normalized;
}

function validOpaqueStreamId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,8192}$/.test(value) ? value : undefined;
}

function requireNow(value: number): number {
  const normalized = validNow(value);
  if (normalized === undefined) throw new TypeError('A valid receipt time is required.');
  return normalized;
}

function validNow(value: unknown): number | undefined {
  return isSafeEpochMilliseconds(value) ? value : undefined;
}

function isSafeEpochMilliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
