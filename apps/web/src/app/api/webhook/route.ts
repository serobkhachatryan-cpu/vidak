/// <reference path="../../../server/server-only-module.d.ts" />
/**
 * POST /api/webhook — AaaS Awareness ingress (receive-only).
 * Empty 200 on verified handling; empty 500 otherwise. No product-session auth.
 */

import { type NextRequest, NextResponse } from 'next/server';
import 'server-only';
import { CORRELATION_HEADER, resolveCorrelationId } from '../../../server/ops-observability';
import { resolveW3dsAwarenessAdmission } from '../../../server/w3ds-awareness-admission';
import type { W3dsAwarenessReceiptStore } from '../../../server/w3ds-awareness-receipts';
import {
  createDefaultAwarenessReceiptStore,
  handleAwarenessWebhookRequest,
  reportAwarenessWebhookOutcome,
  resolveAwarenessWebhookConfig,
  W3DS_AAAS_SIGNATURE_HEADER,
} from '../../../server/w3ds-awareness-webhook';

export const runtime = 'nodejs';

let testReceiptStore: W3dsAwarenessReceiptStore | undefined;

export function setAwarenessWebhookReceiptStoreForTests(
  store: W3dsAwarenessReceiptStore | undefined,
): void {
  testReceiptStore = store;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = resolveCorrelationId(request.headers);
  const rawBody = Buffer.from(await request.arrayBuffer());
  const config = resolveAwarenessWebhookConfig();

  try {
    const result = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: request.headers.get(W3DS_AAAS_SIGNATURE_HEADER),
      config,
      ...(testReceiptStore ? { receipts: testReceiptStore } : {}),
      resolveReceipts: createDefaultAwarenessReceiptStore,
      resolveAdmission: resolveW3dsAwarenessAdmission,
    });
    reportAwarenessWebhookOutcome({ correlationId, outcome: result.outcome });
    return emptyWebhookResponse(result.status, correlationId);
  } catch {
    reportAwarenessWebhookOutcome({ correlationId, outcome: 'failed' });
    return emptyWebhookResponse(500, correlationId);
  }
}

function emptyWebhookResponse(status: 200 | 500, correlationId: string): NextResponse {
  return new NextResponse(null, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      [CORRELATION_HEADER]: correlationId,
    },
  });
}
