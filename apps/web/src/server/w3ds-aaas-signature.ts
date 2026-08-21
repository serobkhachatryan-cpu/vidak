/// <reference path="./server-only-module.d.ts" />
/**
 * Local AaaS HMAC-SHA256 verifier for x-aaas-signature.
 *
 * Computes HMAC-SHA256 over the raw webhook body and compares it to the
 * configured representation only. Does not try hex and base64. Does not use
 * wallet/eID ECDSA verification.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import 'server-only';
import type { W3dsAaasSignatureEncoding } from './server-config';

export type W3dsAaasSignatureVerdict = 'valid' | 'missing_header' | 'malformed' | 'invalid';

export interface VerifyW3dsAaasSignatureInput {
  rawBody: Buffer;
  signatureHeader: string | null | undefined;
  secret: string;
  encoding: W3dsAaasSignatureEncoding;
}

export function verifyW3dsAaasSignature(
  input: VerifyW3dsAaasSignatureInput,
): W3dsAaasSignatureVerdict {
  const header = input.signatureHeader?.trim();
  if (!header) return 'missing_header';

  const provided = decodeConfiguredSignature(header, input.encoding);
  if (!provided) return 'malformed';

  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest();
  if (provided.length !== expected.length) return 'malformed';
  return timingSafeEqual(provided, expected) ? 'valid' : 'invalid';
}

function decodeConfiguredSignature(
  header: string,
  encoding: W3dsAaasSignatureEncoding,
): Buffer | undefined {
  if (encoding === 'hex') {
    if (!/^[0-9a-fA-F]+$/.test(header) || header.length % 2 !== 0) return undefined;
    const decoded = Buffer.from(header, 'hex');
    return decoded.length > 0 ? decoded : undefined;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(header) || header.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(header, 'base64');
  if (decoded.length === 0) return undefined;
  if (decoded.toString('base64') !== header) return undefined;
  return decoded;
}
