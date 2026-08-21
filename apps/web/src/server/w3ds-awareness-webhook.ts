/// <reference path="./server-only-module.d.ts" />
/**
 * Receive-only AaaS webhook ingress.
 *
 * Verifies x-aaas-signature as HMAC-SHA256 of the raw body, validates the
 * documented Awareness envelope, then records a receipt keyed by MetaEnvelope
 * id. Does not apply product rows, mappings, official adapter writes, or eVault
 * writes.
 */

import 'server-only';
import { reportOperationalEvent } from './ops-observability';
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

export type W3dsAwarenessWebhookOutcomeCode =
  | 'awareness_accepted'
  | 'awareness_replayed'
  | 'awareness_rejected'
  | 'awareness_failed';

export function awarenessWebhookDeniedFlags(): W3dsAwarenessWebhookDeniedFlags {
  return deniedFlags;
}

/**
 * Produces a redacted server-side metric event for the receive-only ingress.
 * The only dimensions are an opaque correlation id and a fixed outcome code;
 * raw packets, signatures, secrets, and MetaEnvelope ids are never logged.
 */
export function reportAwarenessWebhookOutcome(input: {
  correlationId: string;
  outcome: HandleAwarenessWebhookResult['outcome'] | 'failed';
}): W3dsAwarenessWebhookOutcomeCode {
  const code: W3dsAwarenessWebhookOutcomeCode =
    input.outcome === 'accepted'
      ? 'awareness_accepted'
      : input.outcome === 'duplicate'
        ? 'awareness_replayed'
        : input.outcome === 'rejected'
          ? 'awareness_rejected'
          : 'awareness_failed';
  reportOperationalEvent({ category: 'w3ds_sync', correlationId: input.correlationId, code });
  return code;
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

  const packet = parseAwarenessEnvelope(input.rawBody);
  if (!packet) return rejected;

  const receipts = loadReceiptStore(input);
  const existing = await receipts.getByGlobalId(packet.id);
  if (existing) {
    return {
      status: 200,
      outcome: 'duplicate',
      globalId: packet.id,
      receiptId: existing.id,
      ...deniedFlags,
    };
  }

  const recorded = await receipts.recordReceipt({
    globalId: packet.id,
    now: (input.now ?? Date.now)(),
  });
  return {
    status: 200,
    outcome: 'accepted',
    globalId: packet.id,
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

/**
 * The AaaS delivery body is authenticated before this parser is called. Still
 * require the complete documented envelope before writing a receipt, so a
 * malformed signed delivery cannot reserve a MetaEnvelope id.
 */
function parseAwarenessEnvelope(rawBody: Buffer): { id: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const packet = parsed as Record<string, unknown>;
  const id = requiredString(packet.id);
  const w3id = requiredString(packet.w3id);
  const schemaId = requiredString(packet.schemaId);
  if (!id || !w3id || !schemaId || !isEName(w3id) || !isRecord(packet.data)) return undefined;
  return { id };
}

function requiredString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isEName(value: string): boolean {
  return /^@[^\s@]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
