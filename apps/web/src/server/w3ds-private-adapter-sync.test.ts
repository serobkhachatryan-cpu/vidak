import type { Channel, Comment, Playlist, Video } from '@w3ds/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { optionalW3dsFileUri, toPrivateOntologyHandle } from './w3ds-private-adapter-project';
import {
  createInMemoryVidakPrivateAdapterSyncService,
  isVidakPrivateAdapterSyncEnabled,
  resetVidakPrivateAdapterSyncServiceForTests,
} from './w3ds-private-adapter-sync';
import { VIDAK_PRIVATE_SCHEMA_IDS } from './w3ds-private-ontology';

const privateOntologyAdapter = {
  ontologyBaseUrl: 'https://vidak.example/api/w3ds/ontology',
  mappingVersion: 1,
  schemaIds: {
    profile: 'schema-profile-local',
    channel: VIDAK_PRIVATE_SCHEMA_IDS.Channel,
    video: VIDAK_PRIVATE_SCHEMA_IDS.Video,
    playlist: VIDAK_PRIVATE_SCHEMA_IDS.Playlist,
    comment: VIDAK_PRIVATE_SCHEMA_IDS.Comment,
  },
};

const channel: Channel = {
  id: 'ch_1',
  ownerId: 'user_1',
  handle: 'creator.demo-user1',
  name: 'Creator Demo',
  description: 'A channel',
  subscriberCount: 2,
  videoCount: 1,
  createdAt: '2026-08-06T01:00:00.000Z',
};

const video: Video = {
  id: 'vid_1',
  channelId: 'ch_1',
  title: 'Hello private sync',
  description: 'Body',
  thumbnailUrl: 'https://cdn.example/thumb.jpg',
  durationSeconds: 12,
  status: 'draft',
  visibility: 'private',
  createdAt: '2026-08-06T01:01:00.000Z',
  updatedAt: '2026-08-06T01:01:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: ['demo'],
};

describe('Vidak-private adapter sync', () => {
  afterEach(() => {
    resetVidakPrivateAdapterSyncServiceForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports disabled when private mode or adapter enablement is missing', () => {
    expect(
      isVidakPrivateAdapterSyncEnabled({
        ontologyMode: 'vidak_private',
        ontologyAdapter: null,
      }),
    ).toBe(false);
    expect(
      isVidakPrivateAdapterSyncEnabled({
        ontologyMode: 'metastate_official',
        ontologyAdapter: privateOntologyAdapter,
      }),
    ).toBe(false);
    expect(
      isVidakPrivateAdapterSyncEnabled({
        ontologyMode: 'vidak_private',
        ontologyAdapter: privateOntologyAdapter,
      }),
    ).toBe(true);
  });

  it('skips sync when private mode is off / adapter disabled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const disabled = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'vidak_private',
      ontologyAdapter: null,
    });
    const skipped = await disabled.syncChannel({ channel, ownerEName: '@creator.w3id' });
    expect(skipped.outcome).toBe('skipped');
    expect(skipped.interoperablePublicW3ds).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    const official = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'metastate_official',
      ontologyAdapter: {
        ...privateOntologyAdapter,
        schemaIds: {
          profile: 'ms-profile',
          channel: 'ms-channel',
          video: 'ms-video',
          playlist: 'ms-playlist',
          comment: 'ms-comment',
        },
      },
    });
    const skippedOfficial = await official.syncVideo({ video, ownerEName: '@creator.w3id' });
    expect(skippedOfficial.outcome).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates a durable private channel projection and mapping when enabled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const service = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'vidak_private',
      ontologyAdapter: privateOntologyAdapter,
      now: () => Date.UTC(2026, 7, 6, 5, 0, 0),
    });

    const result = await service.syncChannel({ channel, ownerEName: '@creator.w3id' });
    expect(result.outcome).toBe('synced');
    expect(result.schemaId).toBe(VIDAK_PRIVATE_SCHEMA_IDS.Channel);
    expect(result.ownership).toBe('vidak_private');
    expect(result.interoperablePublicW3ds).toBe(false);
    expect(result.globalId).toBeTruthy();

    const status = service.getStatus();
    expect(status).toMatchObject({
      enabled: true,
      ontologyMode: 'vidak_private',
      metastateOntologyCalls: false,
      metastateEVaultWrites: false,
      remoteW3dsNetworkCalls: false,
      interoperablePublicW3ds: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is idempotent on retries with the same entity payload', async () => {
    const service = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'vidak_private',
      ontologyAdapter: privateOntologyAdapter,
    });

    const first = await service.syncChannel({ channel, ownerEName: '@creator.w3id' });
    const second = await service.syncChannel({ channel, ownerEName: '@creator.w3id' });
    expect(first.outcome).toBe('synced');
    expect(second.outcome).toBe('unchanged');
    expect(second.globalId).toBe(first.globalId);
  });

  it('syncs video create/update and publish state into a private projection', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const service = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'vidak_private',
      ontologyAdapter: privateOntologyAdapter,
    });

    await service.syncChannel({ channel, ownerEName: '@creator.w3id' });
    const draft = await service.syncVideo({ video, ownerEName: '@creator.w3id' });
    expect(draft.outcome).toBe('synced');
    expect(draft.schemaId).toBe(VIDAK_PRIVATE_SCHEMA_IDS.Video);

    const publishedVideo: Video = {
      ...video,
      status: 'published',
      visibility: 'public',
      publicVideoId: 'pub_1',
      publishedAt: '2026-08-06T02:00:00.000Z',
      updatedAt: '2026-08-06T02:00:00.000Z',
    };
    const published = await service.syncVideo({
      video: publishedVideo,
      ownerEName: '@creator.w3id',
    });
    expect(published.outcome).toBe('synced');
    expect(published.globalId).toBe(draft.globalId);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails safely on invalid entity data and records a failed outbox state', async () => {
    const service = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'vidak_private',
      ontologyAdapter: privateOntologyAdapter,
    });

    await expect(
      service.syncChannel({
        channel: { ...channel, name: '' },
        ownerEName: '@creator.w3id',
      }),
    ).rejects.toThrow(/Channel name is required|Invalid channel/);

    await expect(
      service.syncChannel({
        channel,
        ownerEName: 'not-an-ename',
      }),
    ).rejects.toThrow(/owner eName/);
  });

  it('fails safely when video sync runs without a channel mapping', async () => {
    const service = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'vidak_private',
      ontologyAdapter: privateOntologyAdapter,
    });

    await expect(service.syncVideo({ video, ownerEName: '@creator.w3id' })).rejects.toThrow(
      /channel projection mapping/,
    );
  });

  it('omits non-w3ds media URIs and never invents file envelopes', () => {
    expect(optionalW3dsFileUri('https://cdn.example/a.jpg')).toBeUndefined();
    expect(optionalW3dsFileUri('/var/media/key')).toBeUndefined();
    expect(optionalW3dsFileUri('w3ds://file?id=@creator.w3id/env_1')).toBe(
      'w3ds://file?id=@creator.w3id/env_1',
    );
    expect(toPrivateOntologyHandle('Creator.Demo-abc')).toBe('creator_demo-abc');
  });

  it('projects playlist and comment entities when referenced mappings exist', async () => {
    const service = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'vidak_private',
      ontologyAdapter: privateOntologyAdapter,
    });
    await service.syncChannel({ channel, ownerEName: '@creator.w3id' });
    await service.syncVideo({ video, ownerEName: '@creator.w3id' });

    const playlist: Playlist = {
      id: 'pl_1',
      channelId: 'ch_1',
      title: 'Favorites',
      visibility: 'private',
      items: [{ videoId: 'vid_1', position: 0, addedAt: '2026-08-06T03:00:00.000Z' }],
      createdAt: '2026-08-06T03:00:00.000Z',
      updatedAt: '2026-08-06T03:00:00.000Z',
    };
    const playlistResult = await service.syncPlaylist({
      playlist,
      ownerEName: '@creator.w3id',
    });
    expect(playlistResult.outcome).toBe('synced');
    expect(playlistResult.schemaId).toBe(VIDAK_PRIVATE_SCHEMA_IDS.Playlist);

    const comment: Comment = {
      id: 'cmt_1',
      videoId: 'vid_1',
      authorId: 'user_1',
      body: 'Nice video',
      createdAt: '2026-08-06T03:05:00.000Z',
      likeCount: 0,
      replyCount: 0,
    };
    const commentResult = await service.syncComment({
      comment,
      ownerEName: '@creator.w3id',
      visibility: 'public',
    });
    expect(commentResult.outcome).toBe('synced');
    expect(commentResult.schemaId).toBe(VIDAK_PRIVATE_SCHEMA_IDS.Comment);
  });

  it('never performs remote W3DS network calls during sync', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('unexpected network');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const service = createInMemoryVidakPrivateAdapterSyncService({
      ontologyMode: 'vidak_private',
      ontologyAdapter: privateOntologyAdapter,
    });
    await service.syncChannel({ channel, ownerEName: '@creator.w3id' });
    await service.syncVideo({ video, ownerEName: '@creator.w3id' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(service.getStatus().remoteW3dsNetworkCalls).toBe(false);
  });
});
