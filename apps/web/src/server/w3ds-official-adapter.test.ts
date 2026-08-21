import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { DOCUMENTED_W3DS_ONTOLOGY_BASE_URL, type W3dsOntologyAdapterConfig } from './server-config';
import { InMemoryW3dsAdapterMappingStore, W3dsAdapterMappingService } from './w3ds-adapter-mapping';
import {
  bundledOfficialMappingRuleSources,
  loadOfficialMappingRules,
  W3DS_OFFICIAL_MAPPING_RULES_VERSION,
} from './w3ds-mapping-rules';
import {
  createInMemoryOfficialWeb3Adapter,
  resetOfficialWeb3AdapterForTests,
} from './w3ds-official-adapter';
import {
  FakeW3dsOfficialEVaultClient,
  resolveW3dsOfficialEVaultClient,
} from './w3ds-official-evault-client';
import { FakeW3dsOfficialFileClient } from './w3ds-official-file-client';
import { fromGlobal, resolveOwnerENameFromPath, toGlobal } from './w3ds-official-mapper';
import { InMemoryW3dsPrivateAdapterSyncStore } from './w3ds-private-adapter-sync-store';
import { VIDAK_PRIVATE_SCHEMA_IDS } from './w3ds-private-ontology';
import {
  DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS,
  VIDAK_PRIVATE_PROFILE_SCHEMA_ID_LATCH,
} from './w3ds-schema-id-policy';

const officialAdapter: W3dsOntologyAdapterConfig = {
  ontologyBaseUrl: `${DOCUMENTED_W3DS_ONTOLOGY_BASE_URL}/`,
  mappingVersion: W3DS_OFFICIAL_MAPPING_RULES_VERSION,
  schemaIds: {
    profile: 'schema-profile-configured',
    channel: 'schema-channel-configured',
    video: 'schema-video-configured',
    playlist: 'schema-playlist-configured',
    comment: 'schema-comment-configured',
  },
};

const channelData = {
  id: 'ch_1',
  ownerId: { id: 'user_1', eName: '@creator.w3id' },
  handle: 'creator',
  name: 'Creator Demo',
  description: 'A channel',
  subscriberCount: 2,
  videoCount: 1,
  createdAt: '2026-08-06T01:00:00.000Z',
  updatedAt: '2026-08-06T01:00:00.000Z',
};

const videoData = {
  id: 'vid_1',
  ownerId: { id: 'user_1', eName: '@creator.w3id' },
  channelId: 'ch_1',
  title: 'Hello official sync',
  description: 'Body',
  thumbnailUrl: 'https://cdn.example/thumb.jpg',
  status: 'draft',
  visibility: 'private',
  createdAt: '2026-08-06T01:01:00.000Z',
  updatedAt: '2026-08-06T01:01:00.000Z',
};

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

describe('official handleChange outbox seam', () => {
  afterEach(() => {
    resetOfficialWeb3AdapterForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates then updates the same MetaEnvelope and does not duplicate outbox rows', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const fake = new FakeW3dsOfficialEVaultClient();
    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
      officialClient: fake,
    });

    const first = await adapter.handleChange({ data: channelData, tableName: 'creator_channels' });
    const second = await adapter.handleChange({
      data: { ...channelData, name: 'Creator Demo 2' },
      tableName: 'creator_channels',
    });

    expect(first.outcome).toBe('synced');
    expect(first.remoteWrite).toBe('create');
    expect(second.outcome).toBe('synced');
    expect(second.remoteWrite).toBe('update');
    expect(second.globalId).toBe(first.globalId);
    expect(fake.calls.map((call) => call.method)).toEqual([
      'resolveEvaultUri',
      'createMetaEnvelope',
      'resolveEvaultUri',
      'updateMetaEnvelope',
    ]);
    expect(await outboxStore.listOutboxByStatus('synced')).toHaveLength(1);
    expect(await mappingService.getByLocalId('channel', 'ch_1')).toMatchObject({
      globalId: first.globalId,
      schemaId: 'schema-channel-configured',
    });
    expect(first.globalId).not.toBe('ch_1');
    expect(first.officialEVaultWrites).toBe(false);
    expect(first.interoperablePublicW3ds).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resolveW3dsOfficialEVaultClient().status).toBe('unavailable');
  });

  it('fails closed on rejected official configuration and never reports remote success', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const missing = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: null,
    });
    const missingResult = await missing.adapter.handleChange({
      data: channelData,
      tableName: 'creator_channels',
    });
    expect(missingResult.outcome).toBe('failed');
    expect(missingResult.remoteWrite).toBe('none');
    expect(missingResult.officialEVaultWrites).toBe(false);
    expect(await missing.outboxStore.listOutboxByStatus('pending')).toHaveLength(0);

    const placeholder = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: {
        ...officialAdapter,
        schemaIds: {
          ...officialAdapter.schemaIds,
          video: '<ASSIGNED_BY_METASTATE:Video>',
        },
      },
    });
    const placeholderResult = await placeholder.adapter.handleChange({
      data: videoData,
      tableName: 'videos',
    });
    expect(placeholderResult.outcome).toBe('failed');
    expect(placeholderResult.failureReason).toMatch(/placeholder/i);

    const privateIds = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: {
        ...officialAdapter,
        schemaIds: {
          profile: VIDAK_PRIVATE_PROFILE_SCHEMA_ID_LATCH,
          channel: VIDAK_PRIVATE_SCHEMA_IDS.Channel,
          video: VIDAK_PRIVATE_SCHEMA_IDS.Video,
          playlist: VIDAK_PRIVATE_SCHEMA_IDS.Playlist,
          comment: VIDAK_PRIVATE_SCHEMA_IDS.Comment,
        },
      },
    });
    const privateResult = await privateIds.adapter.handleChange({
      data: channelData,
      tableName: 'creator_channels',
    });
    expect(privateResult.outcome).toBe('failed');
    expect(privateResult.failureReason).toMatch(/private/i);

    const exampleIds = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: {
        ...officialAdapter,
        schemaIds: {
          ...officialAdapter.schemaIds,
          video: DOCUMENTED_EXAMPLE_ONTOLOGY_SCHEMA_IDS.SocialMediaPost,
        },
      },
    });
    const exampleResult = await exampleIds.adapter.handleChange({
      data: videoData,
      tableName: 'videos',
    });
    expect(exampleResult.outcome).toBe('failed');
    expect(exampleResult.failureReason).toMatch(/example ontology ID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records a failed outbox row when the official client is unavailable', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
    });

    const first = await adapter.handleChange({ data: channelData, tableName: 'creator_channels' });
    const second = await adapter.handleChange({ data: channelData, tableName: 'creator_channels' });

    expect(first.outcome).toBe('failed');
    expect(second.outcome).toBe('failed');
    expect(first.remoteWrite).toBe('none');
    expect(first.officialEVaultWrites).toBe(false);
    expect(first.remoteW3dsNetworkCalls).toBe(false);
    expect(first.interoperablePublicW3ds).toBe(false);
    expect(first.httpEvaultClientConstructed).toBe(false);
    expect(first.failureReason).toMatch(/official eVault client is unavailable/);
    expect(adapter.getStatus()).toMatchObject({
      officialEVaultWrites: false,
      remoteW3dsNetworkCalls: false,
      interoperablePublicW3ds: false,
      officialEvaultClient: 'unavailable',
    });

    const failed = await outboxStore.listOutboxByStatus('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.localId).toBe('ch_1');
    expect(failed[0]?.attemptCount).toBe(2);
    expect(await mappingService.getByLocalId('channel', 'ch_1')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips private-mode calls and missing owners without creating outbox work', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const privateMode = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'vidak_private',
      ontologyAdapter: officialAdapter,
      officialClient: new FakeW3dsOfficialEVaultClient(),
    });
    const skippedMode = await privateMode.adapter.handleChange({
      data: channelData,
      tableName: 'creator_channels',
    });
    expect(skippedMode.outcome).toBe('skipped');
    expect(skippedMode.interoperablePublicW3ds).toBe(false);
    expect(await privateMode.outboxStore.listOutboxByStatus('pending')).toHaveLength(0);

    const official = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
      officialClient: new FakeW3dsOfficialEVaultClient(),
    });
    const skippedOwner = await official.adapter.handleChange({
      data: { id: 'ch_2', name: 'No owner' },
      tableName: 'creator_channels',
    });
    expect(skippedOwner.outcome).toBe('skipped');
    expect(skippedOwner.remoteWrite).toBe('none');
    expect(await official.outboxStore.listOutboxByStatus('pending')).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses private projection UUIDs as MetaEnvelope IDs', async () => {
    const fake = new FakeW3dsOfficialEVaultClient();
    fake.nextCreateId = 'priv_proj_1';
    const privateStore = new InMemoryW3dsPrivateAdapterSyncStore();
    await privateStore.upsertProjection({
      entityType: 'channel',
      localId: 'ch_private',
      globalId: 'priv_proj_1',
      schemaId: VIDAK_PRIVATE_SCHEMA_IDS.Channel,
      ownerEName: '@creator.w3id',
      payload: { id: 'priv_proj_1' },
      payloadHash: 'hash',
      mappingVersion: 1,
      now: Date.UTC(2026, 7, 20, 12, 0, 0),
    });

    const { adapter, mappingService, outboxStore } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
      officialClient: fake,
      privateProjectionLookup: privateStore,
    });

    const result = await adapter.handleChange({ data: channelData, tableName: 'creator_channels' });
    expect(result.outcome).toBe('failed');
    expect(result.failureReason).toMatch(/private projection id/);
    expect(result.remoteWrite).toBe('none');
    expect(await mappingService.getByLocalId('channel', 'ch_1')).toBeUndefined();
    expect(await outboxStore.listOutboxByStatus('failed')).toHaveLength(1);
  });

  it('maps video relations to official MetaEnvelope IDs, not local UUIDs', async () => {
    const fake = new FakeW3dsOfficialEVaultClient();
    const { adapter } = createInMemoryOfficialWeb3Adapter({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
      officialClient: fake,
    });

    const channel = await adapter.handleChange({
      data: channelData,
      tableName: 'creator_channels',
    });
    const video = await adapter.handleChange({ data: videoData, tableName: 'videos' });
    expect(channel.outcome).toBe('synced');
    expect(video.outcome).toBe('synced');
    expect(video.globalId).not.toBe('vid_1');
    const videoCreates = fake.calls.filter((call) => call.method === 'createMetaEnvelope');
    expect(videoCreates).toHaveLength(2);
    const videoCreate = videoCreates[1];
    expect(videoCreate).toBeDefined();
    const payload = (videoCreate?.input as { payload: Record<string, unknown> } | undefined)
      ?.payload;
    expect(payload?.channelId).toBe(channel.globalId);
    expect(payload?.channelId).not.toBe('ch_1');
    expect(payload?.thumbnailFileUri).toBe('https://cdn.example/thumb.jpg');
  });
});

describe('official mapper fixtures', () => {
  it('resolves ownerEnamePath and maps documented File URI values without a production client', async () => {
    const mappingService = new W3dsAdapterMappingService({
      store: new InMemoryW3dsAdapterMappingStore(),
      ontologyAdapter: officialAdapter,
      now: () => 1,
    });
    const loaded = loadOfficialMappingRules({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
    });
    const channelMapping = loaded.documents.find((doc) => doc.tableName === 'creator_channels');
    expect(channelMapping).toBeDefined();
    if (!channelMapping) return;
    expect(resolveOwnerENameFromPath(channelData, channelMapping.ownerEnamePath)).toBe(
      '@creator.w3id',
    );
    expect(
      resolveOwnerENameFromPath({ id: 'ch_x' }, channelMapping.ownerEnamePath),
    ).toBeUndefined();

    const mapped = await toGlobal({
      data: {
        ...channelData,
        avatarUrl: 'w3ds://file?id=@creator.w3id/env_1',
        bannerUrl: 'https://cdn.example/banner.jpg',
      },
      mapping: channelMapping,
      mappingService,
    });
    expect(mapped.ownerEName).toBe('@creator.w3id');
    expect(mapped.payload.avatarFileUri).toBe('w3ds://file?id=@creator.w3id/env_1');
    expect(mapped.payload.bannerFileUri).toBe('https://cdn.example/banner.jpg');
    expect(mapped.payload.name).toBe('Creator Demo');

    const roundTrip = await fromGlobal({
      data: mapped.payload,
      mapping: channelMapping,
      mappingService,
    });
    expect(roundTrip.name).toBe('Creator Demo');
    expect(roundTrip.ownerEName).toBe('@creator.w3id');
    expect(bundledOfficialMappingRuleSources()).toHaveLength(4);
  });

  it('uploads and dereferences inline File URI data only through an explicit test client', async () => {
    const mappingService = new W3dsAdapterMappingService({
      store: new InMemoryW3dsAdapterMappingStore(),
      ontologyAdapter: officialAdapter,
      now: () => 1,
    });
    const channelMapping = loadOfficialMappingRules({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
    }).documents.find((doc) => doc.tableName === 'creator_channels');
    expect(channelMapping).toBeDefined();
    if (!channelMapping) return;

    await expect(
      toGlobal({
        data: { ...channelData, avatarUrl: 'data:image/png;base64,aGVsbG8=' },
        mapping: channelMapping,
        mappingService,
      }),
    ).rejects.toMatchObject({ code: 'file_upload_unavailable' });

    const fileClient = new FakeW3dsOfficialFileClient();
    const mapped = await toGlobal({
      data: { ...channelData, avatarUrl: 'data:image/png;base64,aGVsbG8=' },
      mapping: channelMapping,
      mappingService,
      fileUpload: {
        client: fileClient,
        createInput: ({ ownerEName, value }) => ({
          ownerEName,
          filename: 'avatar.png',
          contentType: 'image/png',
          content: value,
          acl: ['*'],
        }),
      },
    });
    expect(mapped.payload.avatarFileUri).toBe('w3ds://file?id=@creator.w3id/file_fake_1');

    await expect(
      fromGlobal({
        data: mapped.payload,
        mapping: channelMapping,
        mappingService,
        fileClient,
      }),
    ).resolves.toMatchObject({ avatarUrl: 'https://files.invalid/file_fake_1/avatar.png' });
  });

  it('passes documented __file array paths through without a client', async () => {
    const mappingService = new W3dsAdapterMappingService({
      store: new InMemoryW3dsAdapterMappingStore(),
      ontologyAdapter: officialAdapter,
      now: () => 1,
    });
    const channelMapping = loadOfficialMappingRules({
      ontologyMode: 'metastate_official',
      ontologyAdapter: officialAdapter,
    }).documents.find((doc) => doc.tableName === 'creator_channels');
    expect(channelMapping).toBeDefined();
    if (!channelMapping) return;

    const mapped = await toGlobal({
      data: {
        ...channelData,
        images: [
          { src: 'https://cdn.example/one.png' },
          { src: 'w3ds://file?id=@creator.w3id/env_2' },
        ],
      },
      mapping: {
        ...channelMapping,
        localToUniversalMap: { imageFileUris: '__file(images[].src),imageFileUris' },
      },
      mappingService,
    });

    expect(mapped.payload.imageFileUris).toEqual([
      'https://cdn.example/one.png',
      'w3ds://file?id=@creator.w3id/env_2',
    ]);
  });
});

describe('P1B browser W3DS boundary', () => {
  it('does not add official handleChange, outbox, or eVault clients to browser packages', () => {
    const roots = [
      join(repoRoot, 'packages/api-client/src'),
      join(repoRoot, 'packages/hooks/src'),
      join(repoRoot, 'apps/web/src/features'),
    ];
    const forbidden = [
      'w3ds-official-adapter',
      'w3ds-official-adapter-outbox',
      'w3ds-official-evault-client',
      'w3ds-official-file-client',
      'w3ds-official-mapper',
      'w3ds-official-sandbox-evault-client',
      'createMetaEnvelope',
      'uploadFile',
      'dereferenceFileUri',
      'handleChange',
      'ontology.w3ds.metastate.foundation',
      'X-ENAME',
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

  it('does not import the platform HTTP eVault client from the official adapter seam', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of [
      'w3ds-official-adapter.ts',
      'w3ds-official-adapter-outbox.ts',
      'w3ds-official-evault-client.ts',
      'w3ds-official-mapper.ts',
    ]) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).not.toMatch(/from ['"]\.\/w3ds-platform-evault['"]/);
      expect(source).not.toMatch(/new RegistryPlatformEVaultClient/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
