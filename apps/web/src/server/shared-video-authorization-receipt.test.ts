import { describe, expect, it, vi } from 'vitest';
import {
  mintSharedVideoAuthorizationReceipt,
  sharedVideoAuthorizationReceiptCookieName,
  sharedVideoAuthorizationReceiptCookieOptions,
  sharedVideoAuthorizationReceiptCookiePath,
  sharedVideoAuthorizationReceiptTtlMs,
  sharedVideoAuthorizationReceiptTtlSeconds,
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
});
