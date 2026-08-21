/// <reference path="./server-only-module.d.ts" />
/**
 * Receive-only AaaS webhook ingress.
 *
 * Verifies x-aaas-signature as HMAC-SHA256 of the raw body, validates the
 * documented Awareness envelope, then records a receipt keyed by MetaEnvelope
 * id. Configured official Channel and draft/private Video schemas may use
 * separate transactional projection seams; no outbound adapter, eVault, or
 * network write is used.
 */

import { createHash } from 'node:crypto';
import 'server-only';
import { getW3dsDatabase } from './db/client';
import { reportOperationalEvent } from './ops-observability';
import { readW3dsAaasWebhookConfig, type W3dsAaasWebhookConfig } from './server-config';
import { verifyW3dsAaasSignature } from './w3ds-aaas-signature';
import type { W3dsAwarenessAdmission, W3dsAwarenessEnvelope } from './w3ds-awareness-admission';
import {
  createPostgresW3dsAwarenessChannelProjection,
  type W3dsAwarenessChannelProjection,
} from './w3ds-awareness-channel-projection';
import {
  createPostgresW3dsAwarenessReceiptStore,
  type W3dsAwarenessReceiptStore,
} from './w3ds-awareness-receipts';
import {
  createPostgresW3dsAwarenessVideoProjection,
  type W3dsAwarenessVideoProjection,
} from './w3ds-awareness-video-projection';

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
  /** Invoked only after HMAC verification and packet parsing. */
  resolveAdmission?: (envelope: W3dsAwarenessEnvelope) => W3dsAwarenessAdmission;
  /** Explicit test injection for an admitted, transactional Channel projection. */
  channelProjection?: W3dsAwarenessChannelProjection;
  /** Invoked only after valid HMAC, packet parsing, and Channel admission. */
  resolveChannelProjection?: () => W3dsAwarenessChannelProjection;
  /** Explicit test injection for an admitted, transactional draft Video projection. */
  videoProjection?: W3dsAwarenessVideoProjection;
  /** Invoked only after valid HMAC, packet parsing, and Video admission. */
  resolveVideoProjection?: () => W3dsAwarenessVideoProjection;
  now?: () => number;
}

export interface HandleAwarenessWebhookResult {
  status: 200 | 500;
  outcome: 'accepted' | 'duplicate' | 'ignored' | 'rejected';
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
  | 'awareness_ignored'
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
        : input.outcome === 'ignored'
          ? 'awareness_ignored'
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
  // The exact raw delivery is what AaaS authenticated. Keep only its SHA-256
  // digest so same-id updates can be distinguished from exact replays without
  // retaining a payload, signature, or secret.
  const payloadHash = createHash('sha256').update(input.rawBody).digest('hex');

  // Admission is intentionally before receipt-store construction. Invalid
  // HMACs never reach it, and it does not allocate the database client.
  const admission = input.resolveAdmission?.(packet);

  // Each eligible projection owns receipt creation as part of its transaction,
  // so a failure cannot acknowledge the packet or leave partial product/mapping
  // rows behind.
  if (admission?.status === 'eligible') {
    const projection =
      admission.mapping.entityType === 'channel'
        ? loadChannelProjection(input)
        : admission.mapping.entityType === 'video'
          ? loadVideoProjection(input)
          : undefined;
    if (!projection) {
      throw new Error('Awareness admission selected an unsupported product projection.');
    }
    const projected = await projection.project({
      envelope: packet,
      mapping: admission.mapping,
      mappingVersion: admission.mappingVersion,
      payloadHash,
      now: (input.now ?? Date.now)(),
    });
    return {
      status: 200,
      outcome:
        projected.outcome === 'duplicate'
          ? 'duplicate'
          : projected.outcome === 'ignored'
            ? 'ignored'
            : 'accepted',
      globalId: packet.id,
      receiptId: projected.receiptId,
      ...deniedFlags,
    };
  }

  const receipts = loadReceiptStore(input);
  const recorded = await receipts.recordReceipt({
    globalId: packet.id,
    payloadHash,
    now: (input.now ?? Date.now)(),
  });
  return {
    status: 200,
    // Direct handler tests deliberately omit admission; retain the original
    // receipt-only acknowledgement seam. Runtime always supplies admission.
    outcome:
      recorded.outcome === 'duplicate'
        ? 'duplicate'
        : admission?.status === 'ignored'
          ? 'ignored'
          : 'accepted',
    globalId: packet.id,
    receiptId: recorded.receipt.id,
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

export function createDefaultAwarenessChannelProjection(): W3dsAwarenessChannelProjection {
  return createPostgresW3dsAwarenessChannelProjection(getW3dsDatabase());
}

export function createDefaultAwarenessVideoProjection(): W3dsAwarenessVideoProjection {
  return createPostgresW3dsAwarenessVideoProjection(getW3dsDatabase());
}

function loadReceiptStore(input: HandleAwarenessWebhookInput): W3dsAwarenessReceiptStore {
  if (input.receipts) return input.receipts;
  if (input.resolveReceipts) return input.resolveReceipts();
  return createDefaultAwarenessReceiptStore();
}

function loadChannelProjection(input: HandleAwarenessWebhookInput): W3dsAwarenessChannelProjection {
  if (input.channelProjection) return input.channelProjection;
  if (input.resolveChannelProjection) return input.resolveChannelProjection();
  return createDefaultAwarenessChannelProjection();
}

function loadVideoProjection(input: HandleAwarenessWebhookInput): W3dsAwarenessVideoProjection {
  if (input.videoProjection) return input.videoProjection;
  if (input.resolveVideoProjection) return input.resolveVideoProjection();
  return createDefaultAwarenessVideoProjection();
}

/**
 * The AaaS delivery body is authenticated before this parser is called. Still
 * require the complete documented envelope before writing a receipt, so a
 * malformed signed delivery cannot reserve a MetaEnvelope id.
 */
function parseAwarenessEnvelope(rawBody: Buffer): W3dsAwarenessEnvelope | undefined {
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
  return { id, w3id, schemaId, data: packet.data };
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
