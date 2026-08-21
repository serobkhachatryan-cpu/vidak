import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readW3dsAaasWebhookConfig } from './server-config';
import { InMemoryW3dsAwarenessReceiptStore } from './w3ds-awareness-receipts';
import {
  handleAwarenessWebhookRequest,
  resolveAwarenessWebhookConfig,
} from './w3ds-awareness-webhook';

vi.mock('server-only', () => ({}));

const secret = 'aaas-test-secret';
const encoding = 'hex' as const;
const packet = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  w3id: '@e4d909c2-5d2f-4a7d-9473-b34b6c0f1a5a',
  schemaId: '550e8400-e29b-41d4-a716-446655440001',
  data: { content: 'Hello, world!' },
};
const rawBody = Buffer.from(JSON.stringify(packet), 'utf8');

function sign(body: Buffer = rawBody, configuredSecret = secret): string {
  return createHmac('sha256', configuredSecret).update(body).digest(encoding);
}

const denied = {
  officialEVaultWrites: false,
  metastateEVaultWrites: false,
  remoteW3dsNetworkCalls: false,
  interoperablePublicW3ds: false,
  httpEvaultClientConstructed: false,
} as const;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function listFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(path));
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('AaaS webhook config', () => {
  it('is unavailable until secret and encoding are both set', () => {
    expect(readW3dsAaasWebhookConfig({})).toBeNull();
    expect(readW3dsAaasWebhookConfig({ W3DS_AAAS_WEBHOOK_SECRET: secret })).toBeNull();
    expect(readW3dsAaasWebhookConfig({ W3DS_AAAS_SIGNATURE_ENCODING: 'hex' })).toBeNull();
    expect(
      readW3dsAaasWebhookConfig({
        W3DS_AAAS_WEBHOOK_SECRET: secret,
        W3DS_AAAS_SIGNATURE_ENCODING: 'hex,base64',
      }),
    ).toBeNull();
    expect(
      readW3dsAaasWebhookConfig({
        W3DS_AAAS_WEBHOOK_SECRET: secret,
        W3DS_AAAS_SIGNATURE_ENCODING: 'hex',
      }),
    ).toEqual({ secret, encoding: 'hex' });
  });
});

describe('AaaS webhook receive-only handler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty-handler 500 without a receipt when config is missing', async () => {
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    const result = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: sign(),
      config: null,
      receipts,
    });
    expect(result).toMatchObject({ status: 500, outcome: 'rejected', ...denied });
    expect(await receipts.getByGlobalId(packet.id)).toBeUndefined();
  });

  it('returns 500 without a receipt when the HMAC header is missing', async () => {
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    const result = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: null,
      config: { secret, encoding },
      receipts,
    });
    expect(result.status).toBe(500);
    expect(await receipts.getByGlobalId(packet.id)).toBeUndefined();
  });

  it('returns 500 without a receipt when the signature is invalid', async () => {
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    const result = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: sign(rawBody, 'wrong-secret'),
      config: { secret, encoding },
      receipts,
    });
    expect(result.status).toBe(500);
    expect(await receipts.getByGlobalId(packet.id)).toBeUndefined();
  });

  it('does not parse or persist when HMAC verification fails', async () => {
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    const result = await handleAwarenessWebhookRequest({
      rawBody: Buffer.from('not-json', 'utf8'),
      signatureHeader: 'deadbeef',
      config: { secret, encoding },
      receipts,
    });
    expect(result.status).toBe(500);
    expect(result.globalId).toBeUndefined();
    expect(await receipts.getByGlobalId(packet.id)).toBeUndefined();
  });

  it('records one receipt after a valid HMAC and returns 200 with denied write flags', async () => {
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    const result = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: sign(),
      config: { secret, encoding },
      receipts,
    });
    expect(result).toMatchObject({
      status: 200,
      outcome: 'accepted',
      globalId: packet.id,
      ...denied,
    });
    const stored = await receipts.getByGlobalId(packet.id);
    expect(stored?.globalId).toBe(packet.id);
    expect(stored?.id).toBe(result.receiptId);
  });

  it('is idempotent on MetaEnvelope id', async () => {
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    const first = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: sign(),
      config: { secret, encoding },
      receipts,
    });
    const changed = Buffer.from(
      JSON.stringify({ ...packet, data: { content: 'Updated' } }),
      'utf8',
    );
    const second = await handleAwarenessWebhookRequest({
      rawBody: changed,
      signatureHeader: sign(changed),
      config: { secret, encoding },
      receipts,
    });
    expect(first.status).toBe(200);
    expect(second).toMatchObject({
      status: 200,
      outcome: 'duplicate',
      globalId: packet.id,
      receiptId: first.receiptId,
      ...denied,
    });
    expect((await receipts.getByGlobalId(packet.id))?.id).toBe(first.receiptId);
  });

  it('returns 500 without a receipt when HMAC is valid but id is missing', async () => {
    const receipts = new InMemoryW3dsAwarenessReceiptStore();
    const body = Buffer.from('{"schemaId":"x"}', 'utf8');
    const result = await handleAwarenessWebhookRequest({
      rawBody: body,
      signatureHeader: sign(body),
      config: { secret, encoding },
      receipts,
    });
    expect(result.status).toBe(500);
    expect(result.globalId).toBeUndefined();
  });

  it.each([
    ['w3id is missing', { ...packet, w3id: undefined }],
    ['w3id is not an eName', { ...packet, w3id: 'not-an-ename' }],
    ['schemaId is blank', { ...packet, schemaId: '   ' }],
    ['data is not an object', { ...packet, data: ['not', 'an', 'object'] }],
  ])(
    'rejects a signed packet when %s before resolving or writing receipts',
    async (_name, value) => {
      const body = Buffer.from(JSON.stringify(value), 'utf8');
      const resolveReceipts = vi.fn(() => new InMemoryW3dsAwarenessReceiptStore());
      const result = await handleAwarenessWebhookRequest({
        rawBody: body,
        signatureHeader: sign(body),
        config: { secret, encoding },
        resolveReceipts,
      });

      expect(result).toMatchObject({ status: 500, outcome: 'rejected', ...denied });
      expect(resolveReceipts).not.toHaveBeenCalled();
    },
  );

  it('reads AaaS config from env without enabling metastate_official', () => {
    vi.stubEnv('W3DS_AAAS_WEBHOOK_SECRET', secret);
    vi.stubEnv('W3DS_AAAS_SIGNATURE_ENCODING', 'hex');
    expect(resolveAwarenessWebhookConfig()).toEqual({ secret, encoding: 'hex' });
    expect(process.env.W3DS_ONTOLOGY_MODE === 'metastate_official').toBe(false);
  });

  it('does not resolve the receipt store when config is missing', async () => {
    const resolveReceipts = vi.fn(() => new InMemoryW3dsAwarenessReceiptStore());
    const result = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: sign(),
      config: null,
      resolveReceipts,
    });
    expect(result.status).toBe(500);
    expect(resolveReceipts).not.toHaveBeenCalled();
  });

  it('does not resolve the receipt store when HMAC verification fails', async () => {
    const resolveReceipts = vi.fn(() => new InMemoryW3dsAwarenessReceiptStore());
    const invalid = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: sign(rawBody, 'wrong-secret'),
      config: { secret, encoding },
      resolveReceipts,
    });
    const malformed = await handleAwarenessWebhookRequest({
      rawBody,
      signatureHeader: 'not-hex',
      config: { secret, encoding },
      resolveReceipts,
    });
    expect(invalid.status).toBe(500);
    expect(malformed.status).toBe(500);
    expect(resolveReceipts).not.toHaveBeenCalled();
  });

  it('does not acknowledge a packet when store construction fails after a valid HMAC', async () => {
    const resolveReceipts = vi.fn(() => {
      throw new Error('database unavailable');
    });
    await expect(
      handleAwarenessWebhookRequest({
        rawBody,
        signatureHeader: sign(),
        config: { secret, encoding },
        resolveReceipts,
      }),
    ).rejects.toThrow(/database unavailable/);
    expect(resolveReceipts).toHaveBeenCalledTimes(1);
  });
});

describe('P2 browser W3DS boundary', () => {
  it('does not add webhook or Awareness modules to browser packages', () => {
    const roots = [
      join(repoRoot, 'packages/api-client/src'),
      join(repoRoot, 'packages/hooks/src'),
      join(repoRoot, 'apps/web/src/features'),
    ];
    const forbidden = [
      'w3ds-awareness-webhook',
      'w3ds-awareness-receipts',
      'w3ds-aaas-signature',
      '/api/webhook',
      'x-aaas-signature',
      'W3DS_AAAS_WEBHOOK_SECRET',
      'createMetaEnvelope',
      'X-ENAME',
      'ontology.w3ds.metastate.foundation',
    ];
    for (const root of roots) {
      for (const file of listFiles(root)) {
        const source = readFileSync(file, 'utf8');
        for (const needle of forbidden) {
          expect(source, `${file} must not contain ${needle}`).not.toContain(needle);
        }
      }
    }
  });

  it('allows only the local AaaS HMAC helper on the inbound path', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of [
      'w3ds-awareness-webhook.ts',
      'w3ds-awareness-receipts.ts',
      'w3ds-aaas-signature.ts',
    ]) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).toMatch(/import ['"]server-only['"]/);
      expect(source).not.toMatch(/verifySignature/);
      expect(source).not.toMatch(/signature-validator/);
      expect(source).not.toMatch(/from ['"]\.\/w3ds-auth['"]/);
      expect(source).not.toMatch(/from ['"]\.\/w3ds-official-adapter['"]/);
      expect(source).not.toMatch(/\bhandleChange\s*\(/);
      expect(source).not.toMatch(/\bfromGlobal\s*\(/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/uploadFile/);
      expect(source).not.toMatch(/from ['"]\.\/w3ds-platform-evault['"]/);
      expect(source).not.toMatch(/createMetaEnvelope/);
      expect(source).not.toMatch(/W3DS_ONTOLOGY_MODE=metastate_official/);
      expect(source).not.toMatch(/creatorChannels|w3dsAdapterMappings/);
      expect(source).not.toMatch(/w3dsPrivateAdapterProjections/);
    }

    const hmacHelper = readFileSync(join(here, 'w3ds-aaas-signature.ts'), 'utf8');
    expect(hmacHelper).toMatch(/createHmac\('sha256'/);
    expect(hmacHelper).toMatch(/timingSafeEqual/);
    expect(hmacHelper).not.toMatch(/verifySignature/);
  });
});
