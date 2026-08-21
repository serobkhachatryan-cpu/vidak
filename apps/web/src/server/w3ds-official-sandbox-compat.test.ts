import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { W3dsOntologyAdapterConfig } from './server-config';
import {
  createInMemoryOfficialWeb3Adapter,
  resetOfficialWeb3AdapterForTests,
} from './w3ds-official-adapter';
import {
  FakeW3dsOfficialEVaultClient,
  isAllowedInjectedOfficialEVaultClientSource,
  resolveW3dsOfficialEVaultClient,
} from './w3ds-official-evault-client';
import {
  assertSandboxFixtureOntology,
  assertSandboxLoopbackHttpUrl,
  W3dsOfficialSandboxEVaultClient,
  W3dsOfficialSandboxEVaultError,
} from './w3ds-official-sandbox-evault-client';
import { DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS } from './w3ds-schema-id-policy';

vi.mock('server-only', () => ({}));

const sandboxAdapter: W3dsOntologyAdapterConfig = {
  ontologyBaseUrl: 'http://127.0.0.1:9/unused-ontology',
  mappingVersion: 1,
  schemaIds: {
    profile: 'schema-profile-configured',
    channel: 'schema-channel-configured',
    video: 'schema-video-configured',
    playlist: 'schema-playlist-configured',
    comment: 'schema-comment-configured',
  },
};

const unavailableRegistryUrl = 'http://127.0.0.1:9';
const liveRegistryUrl = process.env.W3DS_SANDBOX_REGISTRY_URL?.trim();
const liveOwnerEName = process.env.W3DS_SANDBOX_OWNER_ENAME?.trim();
const liveSandboxEnabled =
  process.env.W3DS_SANDBOX_COMPAT_ENABLED === 'true' &&
  Boolean(liveRegistryUrl) &&
  Boolean(liveOwnerEName);

const sandboxPlatformCertificationBody = { platform: 'vidak-p1c-sandbox' } as const;
const sandboxTokenRequestTimeoutMs = 8_000;

/**
 * Test-process-only: request a Registry-issued local platform token.
 * Gated by W3DS_SANDBOX_COMPAT_ENABLED=true and a strict loopback Registry URL.
 * Keeps the token in memory; never logs, prints, or persists it.
 */
async function requestSandboxPlatformToken(
  registryBaseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (process.env.W3DS_SANDBOX_COMPAT_ENABLED !== 'true') {
    throw new W3dsOfficialSandboxEVaultError(
      'Sandbox platform token is disabled until W3DS_SANDBOX_COMPAT_ENABLED=true.',
      'token_disabled',
    );
  }
  const registry = assertSandboxLoopbackHttpUrl(registryBaseUrl, 'Sandbox Registry URL');
  const url = new URL('/platforms/certification', registry);
  assertSandboxLoopbackHttpUrl(url.toString(), 'Sandbox platform certification');
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(sandboxTokenRequestTimeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sandboxPlatformCertificationBody),
    });
  } catch {
    throw new W3dsOfficialSandboxEVaultError(
      'Sandbox platform certification is unavailable.',
      'unavailable',
    );
  }
  if (!response || typeof response.ok !== 'boolean') {
    throw new W3dsOfficialSandboxEVaultError(
      'Sandbox platform certification is unavailable.',
      'unavailable',
    );
  }
  if (!response.ok) {
    throw new W3dsOfficialSandboxEVaultError(
      'Sandbox platform certification rejected the request.',
      'rejected',
    );
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new W3dsOfficialSandboxEVaultError(
      'Sandbox platform certification returned invalid JSON.',
      'invalid_json',
    );
  }
  const token =
    isJsonRecord(payload) && typeof payload.token === 'string' ? payload.token.trim() : '';
  if (!token) {
    throw new W3dsOfficialSandboxEVaultError(
      'Sandbox platform certification did not return a token.',
      'missing_token',
    );
  }
  return token;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function graphqlAuthorization(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    return headers instanceof Headers ? (headers.get('Authorization') ?? undefined) : undefined;
  }
  return headers.Authorization;
}

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

function enableSandboxCompatForTest(): void {
  vi.stubEnv('W3DS_SANDBOX_COMPAT_ENABLED', 'true');
}

function channelData(ownerEName: string, localId = 'ch_p1c_1') {
  return {
    id: localId,
    ownerId: { id: 'user_p1c', eName: ownerEName },
    handle: 'p1c-creator',
    name: 'P1C Channel',
    description: 'Sandbox compatibility fixture',
    subscriberCount: 0,
    videoCount: 0,
    createdAt: '2026-08-21T01:00:00.000Z',
    updatedAt: '2026-08-21T01:00:00.000Z',
  };
}

describe('P1C sandbox client guards', () => {
  afterEach(() => {
    resetOfficialWeb3AdapterForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('refuses sandbox construction and injected sandbox:// clients when compat is disabled', async () => {
    const fetchSpy = vi.fn();
    expect(
      () =>
        new W3dsOfficialSandboxEVaultClient({
          registryBaseUrl: 'http://127.0.0.1:4321',
          fetch: fetchSpy,
        }),
    ).toThrow(/W3DS_SANDBOX_COMPAT_ENABLED/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const sneaky = new FakeW3dsOfficialEVaultClient();
    Object.defineProperty(sneaky, 'source', { value: 'sandbox://127.0.0.1' });
    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: sandboxAdapter,
      officialClient: sneaky,
    });
    const result = await adapter.handleChange({
      data: channelData('@p1c-unavailable.w3id'),
      tableName: 'creator_channels',
    });
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toMatch(/not authentication/);
    expect(result.officialEVaultWrites).toBe(false);
    expect(result.interoperablePublicW3ds).toBe(false);
    expect(result.httpEvaultClientConstructed).toBe(false);
    expect(await mappingService.getByLocalId('channel', 'ch_p1c_1')).toBeUndefined();
    expect(await outboxStore.listOutboxByStatus('failed')).toHaveLength(1);
    expect(resolveW3dsOfficialEVaultClient().status).toBe('unavailable');
  });

  it('still allows an injected Fake client when sandbox compat is disabled', async () => {
    const fake = new FakeW3dsOfficialEVaultClient();
    fake.nextCreateId = 'me_fake_without_compat';
    const { adapter } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: sandboxAdapter,
      officialClient: fake,
    });
    const result = await adapter.handleChange({
      data: channelData('@p1c-fake.w3id'),
      tableName: 'creator_channels',
    });
    expect(result.outcome).toBe('synced');
    expect(result.globalId).toBe('me_fake_without_compat');
    expect(result.officialEVaultWrites).toBe(false);
    expect(resolveW3dsOfficialEVaultClient().status).toBe('unavailable');
  });

  it('refuses production and non-loopback Registry URLs before fetch', () => {
    enableSandboxCompatForTest();
    const fetchSpy = vi.fn();
    expect(
      () =>
        new W3dsOfficialSandboxEVaultClient({
          registryBaseUrl: 'https://registry.w3ds.metastate.foundation',
          fetch: fetchSpy,
        }),
    ).toThrow(W3dsOfficialSandboxEVaultError);
    expect(
      () =>
        new W3dsOfficialSandboxEVaultClient({
          registryBaseUrl: 'https://ontology.w3ds.metastate.foundation',
          fetch: fetchSpy,
        }),
    ).toThrow(/production MetaState hosts/);
    expect(
      () =>
        new W3dsOfficialSandboxEVaultClient({
          registryBaseUrl: 'http://example.com:4321',
          fetch: fetchSpy,
        }),
    ).toThrow(/loopback/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() =>
      assertSandboxLoopbackHttpUrl('https://provisioner.w3ds.metastate.foundation', 'Provisioner'),
    ).toThrow(/production MetaState hosts/);
    expect(() => assertSandboxLoopbackHttpUrl('file://127.0.0.1/graphql', 'File')).toThrow(
      /loopback/,
    );
    expect(() => assertSandboxLoopbackHttpUrl('ftp://localhost:4321', 'FTP')).toThrow(/loopback/);
    expect(
      () =>
        new W3dsOfficialSandboxEVaultClient({
          registryBaseUrl: 'file://localhost',
          fetch: fetchSpy,
        }),
    ).toThrow(/loopback/);
  });

  it('refuses documented example ontology IDs as Channel/Video stand-ins', () => {
    expect(() => assertSandboxFixtureOntology(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.User)).toThrow(
      /User/,
    );
    expect(() =>
      assertSandboxFixtureOntology(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.SocialMediaPost),
    ).toThrow(/SocialMediaPost/);
    expect(() => assertSandboxFixtureOntology(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.File)).toThrow(
      /File/,
    );
    expect(assertSandboxFixtureOntology('schema-channel-configured')).toBe(
      'schema-channel-configured',
    );
  });

  it('keeps production resolve unavailable and does not enable metastate_official', () => {
    expect(process.env.W3DS_ONTOLOGY_MODE === 'metastate_official').toBe(false);
    expect(resolveW3dsOfficialEVaultClient().status).toBe('unavailable');
    expect(isAllowedInjectedOfficialEVaultClientSource('sandbox://127.0.0.1')).toBe(true);
    expect(isAllowedInjectedOfficialEVaultClientSource('http://127.0.0.1:4000')).toBe(false);
  });

  it('resolves a loopback eName and sends documented GraphQL with X-ENAME without claiming a local UUID', async () => {
    enableSandboxCompatForTest();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/resolve')) {
        return new Response(JSON.stringify({ uri: 'http://127.0.0.1:4000/' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/whois')) {
        return new Response(JSON.stringify({ evaultId: 'local-sandbox' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      const isUpdate = body.includes('UpdateSandboxMetaEnvelope');
      return new Response(
        JSON.stringify({
          data: isUpdate
            ? {
                updateMetaEnvelope: {
                  metaEnvelope: {
                    id: 'me_sandbox_1',
                    ontology: 'schema-channel-configured',
                    parsed: { name: 'P1C Channel Updated' },
                  },
                  errors: [],
                },
              }
            : {
                createMetaEnvelope: {
                  metaEnvelope: {
                    id: 'me_sandbox_1',
                    ontology: 'schema-channel-configured',
                    parsed: { name: 'P1C Channel' },
                  },
                  errors: [],
                },
              },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const client = new W3dsOfficialSandboxEVaultClient({
      registryBaseUrl: 'http://127.0.0.1:4321',
      fetch: fetchMock as typeof fetch,
    });
    const resolved = await client.resolveEvaultUri('@p1c-local.w3id');
    expect(resolved).toBe('http://127.0.0.1:4000/');

    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: sandboxAdapter,
      officialClient: client,
    });
    const first = await adapter.handleChange({
      data: channelData('@p1c-local.w3id'),
      tableName: 'creator_channels',
    });
    const second = await adapter.handleChange({
      data: { ...channelData('@p1c-local.w3id'), name: 'P1C Channel Updated' },
      tableName: 'creator_channels',
    });

    expect(first.outcome).toBe('synced');
    expect(second.outcome).toBe('synced');
    expect(first.remoteWrite).toBe('create');
    expect(second.remoteWrite).toBe('update');
    expect(first.globalId).toBe('me_sandbox_1');
    expect(second.globalId).toBe('me_sandbox_1');
    expect(first.globalId).not.toBe('ch_p1c_1');
    expect(first.officialEVaultWrites).toBe(false);
    expect(first.interoperablePublicW3ds).toBe(false);
    expect(first.remoteW3dsNetworkCalls).toBe(false);
    expect(await mappingService.getByLocalId('channel', 'ch_p1c_1')).toMatchObject({
      globalId: 'me_sandbox_1',
      schemaId: 'schema-channel-configured',
    });
    expect(await outboxStore.listOutboxByStatus('synced')).toHaveLength(1);

    const graphqlRequests = client.graphqlRequests();
    expect(graphqlRequests.length).toBeGreaterThan(0);
    expect(
      graphqlRequests.every((request) => request.headers['X-ENAME'] === '@p1c-local.w3id'),
    ).toBe(true);
    expect(graphqlRequests.every((request) => request.headers.Authorization === undefined)).toBe(
      true,
    );
    expect(
      graphqlRequests.every((request) => request.url === 'http://127.0.0.1:4000/graphql'),
    ).toBe(true);
    const createBody = String(
      fetchMock.mock.calls.find((call) =>
        String(call[1]?.body ?? '').includes('CreateSandboxMetaEnvelope'),
      )?.[1]?.body,
    );
    expect(createBody).toContain('createMetaEnvelope');
    expect(createBody).toContain('schema-channel-configured');
    expect(createBody).not.toContain(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.User);
    expect(createBody).not.toContain(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.SocialMediaPost);
    expect(createBody).not.toContain(DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.File);
    expect(resolveW3dsOfficialEVaultClient().status).toBe('unavailable');
  });

  it('fails closed when the local Registry is unavailable and does not create a mapping', async () => {
    enableSandboxCompatForTest();
    const client = new W3dsOfficialSandboxEVaultClient({
      registryBaseUrl: unavailableRegistryUrl,
    });
    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: sandboxAdapter,
      officialClient: client,
    });

    const first = await adapter.handleChange({
      data: channelData('@p1c-unavailable.w3id'),
      tableName: 'creator_channels',
    });
    const second = await adapter.handleChange({
      data: { ...channelData('@p1c-unavailable.w3id'), name: 'P1C Channel 2' },
      tableName: 'creator_channels',
    });

    expect(first.outcome).toBe('failed');
    expect(second.outcome).toBe('failed');
    expect(first.remoteWrite).toBe('none');
    expect(first.officialEVaultWrites).toBe(false);
    expect(first.metastateEVaultWrites).toBe(false);
    expect(first.remoteW3dsNetworkCalls).toBe(false);
    expect(first.interoperablePublicW3ds).toBe(false);
    expect(first.httpEvaultClientConstructed).toBe(false);
    expect(await mappingService.getByLocalId('channel', 'ch_p1c_1')).toBeUndefined();
    const failed = await outboxStore.listOutboxByStatus('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.localId).toBe('ch_p1c_1');
    expect(failed[0]?.attemptCount).toBe(2);
    expect(resolveW3dsOfficialEVaultClient().status).toBe('unavailable');
  });

  it('refuses a non-sandbox injected HTTP client source', async () => {
    const sneaky = new FakeW3dsOfficialEVaultClient();
    Object.defineProperty(sneaky, 'source', { value: 'http://127.0.0.1:4000' });
    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: sandboxAdapter,
      officialClient: sneaky,
    });
    const result = await adapter.handleChange({
      data: channelData('@p1c-unavailable.w3id'),
      tableName: 'creator_channels',
    });
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toMatch(/non-loopback-sandbox|non-fake/);
    expect(result.interoperablePublicW3ds).toBe(false);
    expect(await mappingService.getByLocalId('channel', 'ch_p1c_1')).toBeUndefined();
    expect(await outboxStore.listOutboxByStatus('failed')).toHaveLength(1);
  });

  it('fails closed for an unknown eName with no mapping and no remote success', async () => {
    enableSandboxCompatForTest();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/resolve')) {
        return new Response('not found', { status: 404 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const client = new W3dsOfficialSandboxEVaultClient({
      registryBaseUrl: 'http://127.0.0.1:4321',
      fetch: fetchMock as typeof fetch,
    });
    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: sandboxAdapter,
      officialClient: client,
    });
    const result = await adapter.handleChange({
      data: channelData('@p1c-unknown-ename-not-registered'),
      tableName: 'creator_channels',
    });
    expect(result.outcome).toBe('failed');
    expect(result.remoteWrite).toBe('none');
    expect(result.globalId).toBeUndefined();
    expect(result.officialEVaultWrites).toBe(false);
    expect(result.interoperablePublicW3ds).toBe(false);
    expect(await mappingService.getByLocalId('channel', 'ch_p1c_1')).toBeUndefined();
    expect(await outboxStore.listOutboxByStatus('failed')).toHaveLength(1);
    expect(client.graphqlRequests()).toHaveLength(0);
  });

  it('refuses a platform-token request unless compat is enabled and the Registry is loopback', async () => {
    const fetchSpy = vi.fn();
    vi.stubEnv('W3DS_SANDBOX_COMPAT_ENABLED', 'false');
    await expect(
      requestSandboxPlatformToken('http://127.0.0.1:4321', fetchSpy as typeof fetch),
    ).rejects.toThrow(/W3DS_SANDBOX_COMPAT_ENABLED/);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.stubEnv('W3DS_SANDBOX_COMPAT_ENABLED', 'true');
    await expect(
      requestSandboxPlatformToken(
        'https://registry.w3ds.metastate.foundation',
        fetchSpy as typeof fetch,
      ),
    ).rejects.toThrow(/production MetaState hosts/);
    await expect(
      requestSandboxPlatformToken('http://example.com:4321', fetchSpy as typeof fetch),
    ).rejects.toThrow(/loopback/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requests a local platform token with the documented sandbox body and keeps it in memory', async () => {
    vi.stubEnv('W3DS_SANDBOX_COMPAT_ENABLED', 'true');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe('http://127.0.0.1:4321/platforms/certification');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toBe(JSON.stringify({ platform: 'vidak-p1c-sandbox' }));
      return new Response(JSON.stringify({ token: 'unit-test-sandbox-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const token = await requestSandboxPlatformToken(
      'http://127.0.0.1:4321',
      fetchMock as typeof fetch,
    );
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the Registry issues no platform token', async () => {
    vi.stubEnv('W3DS_SANDBOX_COMPAT_ENABLED', 'true');
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    await expect(
      requestSandboxPlatformToken('http://127.0.0.1:4321', fetchMock as typeof fetch),
    ).rejects.toThrow(/did not return a token/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the injected platform token as Bearer with X-ENAME and redacts it in request records', async () => {
    enableSandboxCompatForTest();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/resolve')) {
        return new Response(JSON.stringify({ uri: 'http://127.0.0.1:4000/' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          data: {
            createMetaEnvelope: {
              metaEnvelope: {
                id: 'me_sandbox_token_1',
                ontology: 'schema-channel-configured',
                parsed: { name: 'P1C Channel' },
              },
              errors: [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new W3dsOfficialSandboxEVaultClient({
      registryBaseUrl: 'http://127.0.0.1:4321',
      fetch: fetchMock as typeof fetch,
      platformToken: 'unit-test-sandbox-token',
    });
    const created = await client.createMetaEnvelope({
      ownerEName: '@p1c-local.w3id',
      schemaId: 'schema-channel-configured',
      payload: { name: 'P1C Channel' },
    });
    expect(created.id).toBe('me_sandbox_token_1');
    const graphqlCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/graphql'));
    expect(graphqlAuthorization(graphqlCall?.[1])?.startsWith('Bearer ')).toBe(true);
    const graphqlRequests = client.graphqlRequests();
    expect(graphqlRequests).toHaveLength(1);
    expect(graphqlRequests[0]?.headers['X-ENAME']).toBe('@p1c-local.w3id');
    expect(graphqlRequests[0]?.headers.Authorization).toBe('Bearer <redacted>');
    expect(JSON.stringify(client.requests)).not.toMatch(/unit-test-sandbox-token/);
  });

  it('fails closed on update when the sandbox platform token is missing', async () => {
    enableSandboxCompatForTest();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/resolve')) {
        return new Response(JSON.stringify({ uri: 'http://127.0.0.1:4000/' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      const isUpdate = body.includes('UpdateSandboxMetaEnvelope');
      if (isUpdate && !graphqlAuthorization(init)?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({
            errors: [
              {
                message: 'Unexpected error.',
                path: ['updateMetaEnvelope'],
                extensions: { code: 'INTERNAL_SERVER_ERROR' },
              },
            ],
            data: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            createMetaEnvelope: {
              metaEnvelope: {
                id: 'me_sandbox_missing_token',
                ontology: 'schema-channel-configured',
                parsed: { name: 'P1C Channel' },
              },
              errors: [],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new W3dsOfficialSandboxEVaultClient({
      registryBaseUrl: 'http://127.0.0.1:4321',
      fetch: fetchMock as typeof fetch,
    });
    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: sandboxAdapter,
      officialClient: client,
    });
    const first = await adapter.handleChange({
      data: channelData('@p1c-local.w3id'),
      tableName: 'creator_channels',
    });
    const second = await adapter.handleChange({
      data: { ...channelData('@p1c-local.w3id'), name: 'P1C Channel Updated' },
      tableName: 'creator_channels',
    });
    expect(first.outcome).toBe('synced');
    expect(second.outcome).toBe('failed');
    expect(second.remoteWrite).toBe('none');
    expect(second.officialEVaultWrites).toBe(false);
    expect(second.metastateEVaultWrites).toBe(false);
    expect(second.remoteW3dsNetworkCalls).toBe(false);
    expect(second.interoperablePublicW3ds).toBe(false);
    expect(second.httpEvaultClientConstructed).toBe(false);
    expect(await mappingService.getByLocalId('channel', 'ch_p1c_1')).toMatchObject({
      globalId: 'me_sandbox_missing_token',
    });
    const failed = await outboxStore.listOutboxByStatus('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.localId).toBe('ch_p1c_1');
    expect(failed[0]?.attemptCount).toBe(2);
    expect(resolveW3dsOfficialEVaultClient().status).toBe('unavailable');
  });
});

describe.skipIf(!liveSandboxEnabled)('P1C live local W3DS sandbox', () => {
  afterEach(() => {
    resetOfficialWeb3AdapterForTests();
  });

  it('creates then updates the same MetaEnvelope with a local platform token', async () => {
    expect(process.env.W3DS_ONTOLOGY_MODE === 'metastate_official').toBe(false);
    expect(liveRegistryUrl).toBeDefined();
    expect(liveOwnerEName).toBeDefined();
    if (!liveRegistryUrl || !liveOwnerEName) return;

    assertSandboxLoopbackHttpUrl(liveRegistryUrl, 'Sandbox Registry URL');
    const platformToken = await requestSandboxPlatformToken(liveRegistryUrl);
    const client = new W3dsOfficialSandboxEVaultClient({
      registryBaseUrl: liveRegistryUrl,
      platformToken,
    });
    const resolved = await client.resolveEvaultUri(liveOwnerEName);
    expect(assertSandboxLoopbackHttpUrl(resolved, 'Resolved eVault URI').toString()).toBe(resolved);
    await expect(client.whois(liveOwnerEName)).resolves.toBeTypeOf('object');

    await expect(client.resolveEvaultUri('@p1c-unknown-ename-not-registered')).rejects.toThrow(
      /404|did not return a uri|unavailable|rejected/,
    );

    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: sandboxAdapter,
      officialClient: client,
    });

    const first = await adapter.handleChange({
      data: channelData(liveOwnerEName),
      tableName: 'creator_channels',
    });
    const second = await adapter.handleChange({
      data: { ...channelData(liveOwnerEName), name: 'P1C Channel Updated' },
      tableName: 'creator_channels',
    });

    expect(first.outcome).toBe('synced');
    expect(second.outcome).toBe('synced');
    expect(first.remoteWrite).toBe('create');
    expect(second.remoteWrite).toBe('update');
    expect(second.globalId).toBe(first.globalId);
    expect(first.globalId).toBeTruthy();
    expect(first.globalId).not.toBe('ch_p1c_1');
    expect(first.globalId).not.toBe('user_p1c');
    expect(first.schemaId).toBe('schema-channel-configured');
    expect(first.officialEVaultWrites).toBe(false);
    expect(first.metastateEVaultWrites).toBe(false);
    expect(first.remoteW3dsNetworkCalls).toBe(false);
    expect(first.interoperablePublicW3ds).toBe(false);
    expect(first.httpEvaultClientConstructed).toBe(false);
    expect(second.officialEVaultWrites).toBe(false);
    expect(second.interoperablePublicW3ds).toBe(false);
    expect(resolveW3dsOfficialEVaultClient().status).toBe('unavailable');

    const graphqlRequests = client.graphqlRequests();
    expect(graphqlRequests.length).toBeGreaterThan(0);
    expect(graphqlRequests.every((request) => request.headers['X-ENAME'] === liveOwnerEName)).toBe(
      true,
    );
    expect(
      graphqlRequests.every((request) => request.headers.Authorization === 'Bearer <redacted>'),
    ).toBe(true);
    expect(graphqlRequests.every((request) => request.url.includes('/graphql'))).toBe(true);
    expect(
      client.requests
        .filter((request) => request.url.includes('/whois'))
        .every((request) => request.headers.Authorization === undefined),
    ).toBe(true);

    const outboxRows = [
      ...(await outboxStore.listOutboxByStatus('synced')),
      ...(await outboxStore.listOutboxByStatus('failed')),
      ...(await outboxStore.listOutboxByStatus('pending')),
    ];
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.localId).toBe('ch_p1c_1');
    expect(outboxRows[0]?.syncStatus).toBe('synced');
    expect(outboxRows[0]?.attemptCount).toBe(2);

    const mapping = await mappingService.getByLocalId('channel', 'ch_p1c_1');
    expect(mapping?.globalId).toBe(first.globalId);
    expect(mapping?.globalId).not.toBe('ch_p1c_1');
    if (!first.globalId) throw new Error('Expected a MetaEnvelope id from local eVault.');
    const stored = await client.readMetaEnvelope({
      ownerEName: liveOwnerEName,
      id: first.globalId,
    });
    expect(stored.ontology).toBe('schema-channel-configured');
    expect(stored.parsed).toMatchObject({ name: 'P1C Channel Updated' });
  });
});

describe('P1C browser W3DS boundary', () => {
  it('does not add the sandbox eVault client to browser packages', () => {
    const roots = [
      join(repoRoot, 'packages/api-client/src'),
      join(repoRoot, 'packages/hooks/src'),
      join(repoRoot, 'apps/web/src/features'),
    ];
    const forbidden = [
      'w3ds-official-sandbox-evault-client',
      'sandbox://127.0.0.1',
      'W3DS_SANDBOX_REGISTRY_URL',
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

  it('does not import the platform HTTP eVault client from the sandbox helper', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'w3ds-official-sandbox-evault-client.ts'), 'utf8');
    expect(source).toMatch(/import ['"]server-only['"]/);
    expect(source).not.toMatch(/from ['"]\.\/w3ds-platform-evault['"]/);
    expect(source).not.toMatch(/new RegistryPlatformEVaultClient/);
    expect(source).not.toMatch(/storeMetaEnvelope/);
    expect(source).not.toMatch(/POST \/platforms\/certification/);
    expect(source).not.toContain('/platforms/certification');
    expect(source).not.toMatch(/uploadFile/);
    expect(source).not.toMatch(/\/api\/webhook/);
    expect(source).not.toMatch(/console\.(log|info|debug|warn|error)/);
    expect(source).not.toMatch(/writeFile|appendFile|localStorage|sessionStorage/);
    expect(source).not.toMatch(/W3DS_SANDBOX_PLATFORM_TOKEN/);
  });
});
