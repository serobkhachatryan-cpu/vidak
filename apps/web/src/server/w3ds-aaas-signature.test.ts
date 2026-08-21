import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyW3dsAaasSignature } from './w3ds-aaas-signature';

vi.mock('server-only', () => ({}));

const secret = 'aaas-test-secret';
const rawBody = Buffer.from('{"id":"global-1"}', 'utf8');

function hmac(encoding: 'hex' | 'base64', body: Buffer = rawBody): string {
  return createHmac('sha256', secret).update(body).digest(encoding);
}

describe('AaaS HMAC-SHA256 signature helper', () => {
  it('accepts a hex digest when hex is configured', () => {
    expect(
      verifyW3dsAaasSignature({
        rawBody,
        signatureHeader: hmac('hex'),
        secret,
        encoding: 'hex',
      }),
    ).toBe('valid');
  });

  it('accepts a base64 digest when base64 is configured', () => {
    expect(
      verifyW3dsAaasSignature({
        rawBody,
        signatureHeader: hmac('base64'),
        secret,
        encoding: 'base64',
      }),
    ).toBe('valid');
  });

  it('does not fall back from hex to base64', () => {
    expect(
      verifyW3dsAaasSignature({
        rawBody,
        signatureHeader: hmac('base64'),
        secret,
        encoding: 'hex',
      }),
    ).toBe('malformed');
  });

  it('does not fall back from base64 to hex', () => {
    expect(
      verifyW3dsAaasSignature({
        rawBody,
        signatureHeader: hmac('hex'),
        secret,
        encoding: 'base64',
      }),
    ).toBe('malformed');
  });

  it('rejects a missing header', () => {
    expect(
      verifyW3dsAaasSignature({
        rawBody,
        signatureHeader: null,
        secret,
        encoding: 'hex',
      }),
    ).toBe('missing_header');
  });

  it('rejects a malformed hex header', () => {
    expect(
      verifyW3dsAaasSignature({
        rawBody,
        signatureHeader: 'not-hex',
        secret,
        encoding: 'hex',
      }),
    ).toBe('malformed');
  });

  it('rejects an invalid digest of the same encoding', () => {
    const other = createHmac('sha256', 'other-secret').update(rawBody).digest('hex');
    expect(
      verifyW3dsAaasSignature({
        rawBody,
        signatureHeader: other,
        secret,
        encoding: 'hex',
      }),
    ).toBe('invalid');
  });

  it('HMACs the exact raw bytes, not a re-serialized JSON object', () => {
    const spaced = Buffer.from('{ "id" : "global-1" }', 'utf8');
    expect(
      verifyW3dsAaasSignature({
        rawBody: spaced,
        signatureHeader: hmac('hex'),
        secret,
        encoding: 'hex',
      }),
    ).toBe('invalid');
    expect(
      verifyW3dsAaasSignature({
        rawBody: spaced,
        signatureHeader: hmac('hex', spaced),
        secret,
        encoding: 'hex',
      }),
    ).toBe('valid');
  });
});
