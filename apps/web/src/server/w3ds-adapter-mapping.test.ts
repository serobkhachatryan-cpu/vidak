import { describe, expect, it } from 'vitest';
import type { W3dsOntologyAdapterConfig } from './server-config';
import {
  InMemoryW3dsAdapterMappingStore,
  W3DS_ADAPTER_ENTITY_TABLES,
  W3dsAdapterMappingError,
  W3dsAdapterMappingService,
} from './w3ds-adapter-mapping';

const ontologyAdapter: W3dsOntologyAdapterConfig = {
  ontologyBaseUrl: 'https://ontology.example.com/',
  mappingVersion: 1,
  schemaIds: {
    profile: 'schema-profile-configured',
    channel: 'schema-channel-configured',
    video: 'schema-video-configured',
    playlist: 'schema-playlist-configured',
    comment: 'schema-comment-configured',
  },
};

describe('W3DS adapter mapping foundation', () => {
  it('maps entity types to the local table names used by Mapping Rules', () => {
    expect(W3DS_ADAPTER_ENTITY_TABLES).toEqual({
      profile: 'w3ds_platform_users',
      channel: 'creator_channels',
      video: 'videos',
      playlist: 'playlists',
      comment: 'comments',
    });
  });

  it('fails closed when Ontology schema IDs are not configured', async () => {
    const service = new W3dsAdapterMappingService({
      store: new InMemoryW3dsAdapterMappingStore(),
      ontologyAdapter: null,
    });

    expect(() => service.requireOntologyAdapter()).toThrow(W3dsAdapterMappingError);
    expect(() => service.requireOntologyAdapter()).toThrow(/W3DS_ONTOLOGY_ADAPTER_ENABLED/);
    await expect(
      service.recordMapping({
        entityType: 'video',
        localId: 'vid_1',
        globalId: 'me_1',
        ownerEName: '@creator.w3id',
      }),
    ).rejects.toThrow(/schema IDs must not be guessed/i);
  });

  it('records an idempotent local↔global mapping with owner eName and schemaId', async () => {
    const store = new InMemoryW3dsAdapterMappingStore();
    const service = new W3dsAdapterMappingService({
      store,
      ontologyAdapter,
      now: () => Date.UTC(2026, 7, 5, 12, 0, 0),
    });

    const first = await service.recordMapping({
      entityType: 'video',
      localId: 'vid_1',
      globalId: 'me_video_1',
      ownerEName: '@creator.w3id',
    });
    const second = await service.recordMapping({
      entityType: 'video',
      localId: 'vid_1',
      globalId: 'me_video_1',
      ownerEName: '@creator.w3id',
    });

    expect(first).toMatchObject({
      entityType: 'video',
      entityTable: 'videos',
      localId: 'vid_1',
      globalId: 'me_video_1',
      ownerEName: '@creator.w3id',
      schemaId: 'schema-video-configured',
      mappingVersion: 1,
    });
    expect(second.id).toBe(first.id);
    expect(await service.getByLocalId('video', 'vid_1')).toEqual(first);
    expect(await service.getByGlobalId('me_video_1')).toEqual(first);
  });

  it('rejects conflicting MetaEnvelope or local IDs and invalid owners', async () => {
    const service = new W3dsAdapterMappingService({
      store: new InMemoryW3dsAdapterMappingStore(),
      ontologyAdapter,
      now: () => 1,
    });

    await service.recordMapping({
      entityType: 'channel',
      localId: 'ch_1',
      globalId: 'me_ch_1',
      ownerEName: '@creator.w3id',
    });

    await expect(
      service.recordMapping({
        entityType: 'channel',
        localId: 'ch_1',
        globalId: 'me_other',
        ownerEName: '@creator.w3id',
      }),
    ).rejects.toThrow(/already mapped/);

    await expect(
      service.recordMapping({
        entityType: 'channel',
        localId: 'ch_2',
        globalId: 'me_ch_1',
        ownerEName: '@creator.w3id',
      }),
    ).rejects.toThrow(/already mapped/);

    await expect(
      service.recordMapping({
        entityType: 'profile',
        localId: 'user_1',
        globalId: 'me_user_1',
        ownerEName: 'not-an-ename',
      }),
    ).rejects.toThrow(/owner eName/);
  });

  it('stamps configured schema IDs per entity type without inventing defaults', async () => {
    const service = new W3dsAdapterMappingService({
      store: new InMemoryW3dsAdapterMappingStore(),
      ontologyAdapter,
      now: () => 1,
    });

    expect(service.resolveSchemaId('profile')).toBe('schema-profile-configured');
    expect(service.resolveSchemaId('comment')).toBe('schema-comment-configured');

    const profile = await service.recordMapping({
      entityType: 'profile',
      localId: 'user_1',
      globalId: 'me_user_1',
      ownerEName: '@user.w3id',
    });
    expect(profile.schemaId).toBe('schema-profile-configured');
    expect(profile.entityTable).toBe('w3ds_platform_users');
  });
});
