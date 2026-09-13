import { describe, expect, it, vi } from 'vitest';
import {
  clearSharedVideoSourceRefreshCookieOptions,
  fingerprintSharedVideoAuthorizationReceipt,
  mintSharedVideoAuthorizationReceipt,
  sharedVideoAuthorizationReceiptCookieName,
  sharedVideoAuthorizationReceiptCookieOptions,
  sharedVideoAuthorizationReceiptCookiePath,
  sharedVideoAuthorizationReceiptTtlMs,
  sharedVideoAuthorizationReceiptTtlSeconds,
  sharedVideoSourceRefreshCookieName,
  sharedVideoSourceRefreshCookieOptions,
  sharedVideoSourceRefreshCookiePath,
  sharedVideoSourceRefreshCookieTtlSeconds,
  sharedVideoStreamAuthorizationReceiptCookieName,
  sharedVideoStreamAuthorizationReceiptCookieOptions,
  sharedVideoStreamAuthorizationReceiptCookiePath,
  verifySharedVideoAuthorizationReceipt,
} from './shared-video-authorization-receipt';

vi.mock('server-only', () => ({}));

const secret = 'shared-video-receipt-test-secret-0123456789';
const env = { W3DS_AUTH_JWT_SECRET: secret };
const viewerEName = '@viewer';
const streamId = 'v2.opaque-stream-id_12345.signature';
const now = 1_750_000_000_000;

function mint() {
  return mintSharedVideoAuthorizationReceipt({ viewerEName, streamId, env, now });
}

describe('shared-video authorization receipts', () => {
  it('mints an opaque receipt bound to the exact viewer and stream', () => {
    const receipt = mint();

    expect(receipt.startsWith('svr1.')).toBe(true);
    expect(receipt).not.toContain(viewerEName);
    expect(receipt).not.toContain(streamId);
    const payload = receipt.split('.')[1];
    if (!payload) throw new Error('Receipt payload was unexpectedly absent.');
    const decodedPayload = Buffer.from(payload, 'base64url').toString('utf8');
    expect(decodedPayload).not.toContain(viewerEName);
    expect(decodedPayload).not.toContain(streamId);
    expect(
      verifySharedVideoAuthorizationReceipt({ receipt, viewerEName, streamId, env, now }),
    ).toBe(true);
  });

  it('derives a secret-keyed local cache fingerprint without retaining the receipt', () => {
    const receipt = mint();
    const fingerprint = fingerprintSharedVideoAuthorizationReceipt(receipt, env);

    expect(fingerprint).not.toContain(receipt);
    expect(fingerprint).not.toContain(viewerEName);
    expect(fingerprintSharedVideoAuthorizationReceipt(receipt, env)).toBe(fingerprint);
    expect(fingerprintSharedVideoAuthorizationReceipt(`${receipt}x`, env)).not.toBe(fingerprint);
  });

  it('rejects a receipt for a different viewer or stream', () => {
    const receipt = mint();

    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt,
        viewerEName: '@someone-else',
        streamId,
        env,
        now,
      }),
    ).toBe(false);
    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt,
        viewerEName,
        streamId: 'v2.different-stream-id.signature',
        env,
        now,
      }),
    ).toBe(false);
  });

  it('rejects a tampered or non-canonical receipt', () => {
    const receipt = mint();
    const [version, payload, signature] = receipt.split('.');
    if (!version || !payload || !signature) throw new Error('Receipt was unexpectedly malformed.');
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;

    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt: `${version}.${tamperedPayload}.${signature}`,
        viewerEName,
        streamId,
        env,
        now,
      }),
    ).toBe(false);
    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt: `${version}.${payload}.${signature}.extra`,
        viewerEName,
        streamId,
        env,
        now,
      }),
    ).toBe(false);
  });

  it('expires exactly after its short 45-second lifetime', () => {
    const receipt = mint();

    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt,
        viewerEName,
        streamId,
        env,
        now: now + sharedVideoAuthorizationReceiptTtlMs - 1,
      }),
    ).toBe(true);
    expect(
      verifySharedVideoAuthorizationReceipt({
        receipt,
        viewerEName,
        streamId,
        env,
        now: now + sharedVideoAuthorizationReceiptTtlMs,
      }),
    ).toBe(false);
  });

  it('fails closed when the mandatory W3DS secret is missing or too short', () => {
    expect(() =>
      mintSharedVideoAuthorizationReceipt({
        viewerEName,
        streamId,
        env: {},
        now,
      }),
    ).toThrow(/W3DS_AUTH_JWT_SECRET/);
    expect(() =>
      verifySharedVideoAuthorizationReceipt({
        receipt: mint(),
        viewerEName,
        streamId,
        env: { W3DS_AUTH_JWT_SECRET: 'short' },
        now,
      }),
    ).toThrow(/W3DS_AUTH_JWT_SECRET/);
  });

  it('provides a tightly scoped secure HttpOnly cookie contract', () => {
    expect(sharedVideoAuthorizationReceiptCookieName).toBe(
      '__Secure-vidak-shared-video-authorization',
    );
    expect(sharedVideoAuthorizationReceiptCookiePath).toBe('/api');
    expect(sharedVideoAuthorizationReceiptCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: sharedVideoAuthorizationReceiptCookiePath,
      maxAge: sharedVideoAuthorizationReceiptTtlSeconds,
    });
  });

  it('isolates eVault authorization receipts to the exact stream route', () => {
    expect(sharedVideoStreamAuthorizationReceiptCookieName).toBe(
      '__Secure-vidak-shared-video-stream-authorization',
    );
    expect(sharedVideoStreamAuthorizationReceiptCookiePath(streamId)).toBe(
      `/api/evault/videos/${streamId}`,
    );
    expect(sharedVideoStreamAuthorizationReceiptCookieOptions(streamId)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: `/api/evault/videos/${streamId}`,
      maxAge: sharedVideoAuthorizationReceiptTtlSeconds,
    });
    expect(() => sharedVideoStreamAuthorizationReceiptCookiePath('not/a-stream')).toThrow(
      /opaque stream ID/i,
    );
  });

  it('provides a short, narrowly scoped one-shot source-refresh marker', () => {
    expect(sharedVideoSourceRefreshCookieName).toBe('__Secure-vidak-shared-video-source-refresh');
    expect(sharedVideoSourceRefreshCookiePath).toBe('/api/evault/videos');
    expect(sharedVideoSourceRefreshCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: sharedVideoSourceRefreshCookiePath,
      maxAge: sharedVideoSourceRefreshCookieTtlSeconds,
    });
    expect(clearSharedVideoSourceRefreshCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: sharedVideoSourceRefreshCookiePath,
      maxAge: 0,
    });
  });
});
