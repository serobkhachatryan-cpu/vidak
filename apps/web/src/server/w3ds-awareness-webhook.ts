/// <reference path="./server-only-module.d.ts" />
/**
 * Receive-only AaaS webhook ingress.
 *
 * Verifies x-aaas-signature as HMAC-SHA256 of the raw body, then records a
 * receipt keyed by MetaEnvelope id. Does not apply product rows, mappings,
 * official adapter writes, or eVault writes.
 */

import 'server-only';
import { readW3dsAaasWebhookConfig, type W3dsAaasWebhookConfig } from './server-config';
import { verifyW3dsAaasSignature } from './w3ds-aaas-signature';
import {
  createPostgresW3dsAwarenessReceiptStore,
  type W3dsAwarenessReceiptStore,
} from './w3ds-awareness-receipts';

export const W3DS_AAAS_SIGNATURE_HEADER = 'x-aaas-signature';

const deniedFlags = {
  officialEVaultWrites: false,
  metastateEVaultWrites: false,
  remoteW3dsNetworkCalls: false,
  interoperablePublicW3ds: false,
  httpEvaultClientConstructed: false,
} as const;

export type W3dsAwarenessWebhookDeniedFlags = typeof deniedFlags;

export interface HandleAwarenessWebhookInput {
  rawBody: Buffer;
  signatureHeader: string | null | undefined;
  config: W3dsAaasWebhookConfig | null;
  /**
   * Explicit test injection. Never a constructed Postgres store in production
   * argument assembly — production passes `resolveReceipts` instead.
   */
  receipts?: W3dsAwarenessReceiptStore;
  /** Invoked only after a valid HMAC when `receipts` is not injected. */
  resolveReceipts?: () => W3dsAwarenessReceiptStore;
  now?: () => number;
}

export interface HandleAwarenessWebhookResult {
  status: 200 | 500;
  outcome: 'accepted' | 'duplicate' | 'rejected';
  globalId?: string;
  receiptId?: string;
  officialEVaultWrites: false;
  metastateEVaultWrites: false;
  remoteW3dsNetworkCalls: false;
  interoperablePublicW3ds: false;
  httpEvaultClientConstructed: false;
}

export function awarenessWebhookDeniedFlags(): W3dsAwarenessWebhookDeniedFlags {
  return deniedFlags;
}

export async function handleAwarenessWebhookRequest(
  input: HandleAwarenessWebhookInput,
): Promise<HandleAwarenessWebhookResult> {
  const rejected: HandleAwarenessWebhookResult = {
    status: 500,
    outcome: 'rejected',
    ...deniedFlags,
  };

  if (!input.config) return rejected;

  const verdict = verifyW3dsAaasSignature({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    secret: input.config.secret,
    encoding: input.config.encoding,
  });
  if (verdict !== 'valid') return rejected;

  const globalId = extractMetaEnvelopeId(input.rawBody);
  if (!globalId) return rejected;

  const receipts = loadReceiptStore(input);
  const existing = await receipts.getByGlobalId(globalId);
  if (existing) {
    return {
      status: 200,
      outcome: 'duplicate',
      globalId,
      receiptId: existing.id,
      ...deniedFlags,
    };
  }

  const recorded = await receipts.recordReceipt({
    globalId,
    now: (input.now ?? Date.now)(),
  });
  return {
    status: 200,
    outcome: 'accepted',
    globalId,
    receiptId: recorded.id,
    ...deniedFlags,
  };
}

export function resolveAwarenessWebhookConfig(
  env: Record<string, string | undefined> = process.env,
): W3dsAaasWebhookConfig | null {
  return readW3dsAaasWebhookConfig(env);
}

export function createDefaultAwarenessReceiptStore(): W3dsAwarenessReceiptStore {
  return createPostgresW3dsAwarenessReceiptStore();
}

function loadReceiptStore(input: HandleAwarenessWebhookInput): W3dsAwarenessReceiptStore {
  if (input.receipts) return input.receipts;
  if (input.resolveReceipts) return input.resolveReceipts();
  return createDefaultAwarenessReceiptStore();
}

function extractMetaEnvelopeId(rawBody: Buffer): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const id = (parsed as Record<string, unknown>).id;
  if (typeof id !== 'string') return undefined;
  const trimmed = id.trim();
  return trimmed || undefined;
}
