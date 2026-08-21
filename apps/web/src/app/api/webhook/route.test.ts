import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getW3dsDatabase } from '../../../server/db/client';
import { setOperationalLogSinkForTests } from '../../../server/ops-observability';
import {
  InMemoryW3dsAwarenessReceiptStore,
  type W3dsAwarenessReceiptStore,
} from '../../../server/w3ds-awareness-receipts';
import { POST, setAwarenessWebhookReceiptStoreForTests } from './route';

vi.mock('server-only', () => ({}));

vi.mock('../../../server/db/client', () => ({
  getW3dsDatabase: vi.fn(() => {
    throw new Error('database client must not be constructed');
  }),
}));

const secret = 'aaas-route-secret';
const packet = {
  id: 'route-global-id-1',
  w3id: '@user.w3id',
  schemaId: 'schema-channel-configured',
  data: { name: 'Ignored in slice 1' },
};
const rawBody = JSON.stringify(packet);

function signedRequest(
  body = rawBody,
  header = createHmac('sha256', secret).update(body).digest('hex'),
) {
  return new NextRequest('https://vidak.example/api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aaas-signature': header,
    },
    body,
  });
}

describe('POST /api/webhook', () => {
  afterEach(() => {
    setAwarenessWebhookReceiptStoreForTests(undefined);
    setOperationalLogSinkForTests(undefined);
    vi.mocked(getW3dsDatabase).mockClear();
    vi.unstubAllEnvs();
  });

  it('is a Node runtime route that reads the raw body once', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'route.ts'), 'utf8');
    expect(source).toMatch(/export const runtime = 'nodejs'/);
    expect(source).toMatch(/arrayBuffer\(\)/);
    expect(source).not.toMatch(/request\.json\(/);
    expect(source).not.toMatch(/verifySignature/);
    expect(source).not.toMatch(/handleChange/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/testReceiptStore \?\? createDefaultAwarenessReceiptStore\(\)/);
    expect(source).toMatch(/resolveReceipts: createDefaultAwarenessReceiptStore/);
  });

  it('returns empty 500 and never constructs the database client when config is missing', async () => {
    const response = await POST(signedRequest());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
    expect(getW3dsDatabase).not.toHaveBeenCalled();
  });

  it('returns empty 500 and never constructs the database client for an invalid HMAC', async () => {
    vi.stubEnv('W3DS_AAAS_WEBHOOK_SECRET', secret);
    vi.stubEnv('W3DS_AAAS_SIGNATURE_ENCODING', 'hex');
    const response = await POST(signedRequest(rawBody, 'a'.repeat(64)));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
    expect(getW3dsDatabase).not.toHaveBeenCalled();
  });

  it('returns empty 500 and never constructs the database client for a malformed HMAC', async () => {
    vi.stubEnv('W3DS_AAAS_WEBHOOK_SECRET', secret);
    vi.stubEnv('W3DS_AAAS_SIGNATURE_ENCODING', 'hex');
    const response = await POST(signedRequest(rawBody, 'not-hex'));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
    expect(getW3dsDatabase).not.toHaveBeenCalled();
  });

  it('returns empty 500 with no receipt when store construction fails after a valid HMAC', async () => {
    vi.stubEnv('W3DS_AAAS_WEBHOOK_SECRET', secret);
    vi.stubEnv('W3DS_AAAS_SIGNATURE_ENCODING', 'hex');
    const response = await POST(signedRequest());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
    expect(getW3dsDatabase).toHaveBeenCalledTimes(1);
  });

  it('returns empty 500 with no receipt when a query fails after a valid HMAC', async () => {
    vi.stubEnv('W3DS_AAAS_WEBHOOK_SECRET', secret);
    vi.stubEnv('W3DS_AAAS_SIGNATURE_ENCODING', 'hex');
    const receipts: W3dsAwarenessReceiptStore = {
      getByGlobalId: async () => {
        throw new Error('database query failed');
      },
      recordReceipt: async () => {
        throw new Error('receipt must not be written');
      },
    };
    setAwarenessWebhookReceiptStoreForTests(receipts);
    const response = await POST(signedRequest());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
    expect(getW3dsDatabase).not.toHaveBeenCalled();
  });

  it('returns empty 200 and one receipt after a valid HMAC', async () => {
    vi.stubEnv('W3DS_AAAS_WEBHOOK_SECRET', secret);
    vi.stubEnv('W3DS_AAAS_SIGNATURE_ENCODING', 'hex');
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    setAwarenessWebhookReceiptStoreForTests(receipts);

    const first = await POST(signedRequest());
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('');
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(getW3dsDatabase).not.toHaveBeenCalled();

    const second = await POST(signedRequest());
    expect(second.status).toBe(200);
    expect((await receipts.getByGlobalId(packet.id))?.globalId).toBe(packet.id);
    expect(getW3dsDatabase).not.toHaveBeenCalled();
  });

  it('emits redacted accepted, replayed, rejected, and failed outcome metrics', async () => {
    const logs: string[] = [];
    setOperationalLogSinkForTests((line) => logs.push(line));
    vi.stubEnv('W3DS_AAAS_WEBHOOK_SECRET', secret);
    vi.stubEnv('W3DS_AAAS_SIGNATURE_ENCODING', 'hex');
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    setAwarenessWebhookReceiptStoreForTests(receipts);

    expect((await POST(signedRequest())).status).toBe(200);
    expect((await POST(signedRequest())).status).toBe(200);
    expect((await POST(signedRequest(rawBody, 'bad'))).status).toBe(500);

    setAwarenessWebhookReceiptStoreForTests({
      getByGlobalId: async () => {
        throw new Error('database query failed with secret=never-log-me');
      },
      recordReceipt: async () => {
        throw new Error('unreachable');
      },
    });
    const newPacket = JSON.stringify({ ...packet, id: 'route-global-id-2' });
    expect((await POST(signedRequest(newPacket))).status).toBe(500);

    expect(logs.join('\n')).toContain('"code":"awareness_accepted"');
    expect(logs.join('\n')).toContain('"code":"awareness_replayed"');
    expect(logs.join('\n')).toContain('"code":"awareness_rejected"');
    expect(logs.join('\n')).toContain('"code":"awareness_failed"');
    expect(logs.join('\n')).not.toContain('never-log-me');
    expect(logs.join('\n')).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(rawBody);
  });
});
