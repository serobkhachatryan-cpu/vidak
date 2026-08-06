import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreatorVideoService, PostgresCreatorVideoStore } from '../creator-video';
import { LocalDiskMediaStorage, MediaAssetService, PostgresMediaAssetStore } from '../media-asset';
import {
  createPostgresW3dsAdapterMappingStore,
  W3dsAdapterMappingService,
} from '../w3ds-adapter-mapping';
import {
  createVidakPrivateAdapterSyncService,
  PostgresW3dsPrivateAdapterSyncStore,
} from '../w3ds-private-adapter-sync';
import { VIDAK_PRIVATE_SCHEMA_IDS } from '../w3ds-private-ontology';
import { chunkedBody, createIntegrationHarness } from './integration-harness';

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

describe('Vidak-private adapter sync integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not sync when private adapter enablement is off', async () => {
    const harness = await createIntegrationHarness();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const sync = createVidakPrivateAdapterSyncService({
        ontologyMode: 'vidak_private',
        ontologyAdapter: null,
        store: new PostgresW3dsPrivateAdapterSyncStore(harness.db),
        mappingService: new W3dsAdapterMappingService({
          store: createPostgresW3dsAdapterMappingStore(harness.db),
          ontologyAdapter: null,
        }),
      });

      const accessToken = await harness.loginAs({
        eName: '@creator.w3id',
        eVaultId: 'ev_creator',
        eVaultUri: 'https://evault.example/creator',
      });

      const channel = await harness.videoService.ensureCreatorChannel(accessToken);
      const result = await sync.syncChannel({
        channel,
        ownerEName: '@creator.w3id',
      });
      expect(result.outcome).toBe('skipped');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it('publishes a video and writes a durable private projection without remote W3DS calls', async () => {
    const harness = await createIntegrationHarness();
    const fetchSpy = vi.fn(async () => {
      throw new Error('unexpected remote W3DS call');
    });
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const mappingService = new W3dsAdapterMappingService({
        store: createPostgresW3dsAdapterMappingStore(harness.db),
        ontologyAdapter: privateOntologyAdapter,
      });
      const sync = createVidakPrivateAdapterSyncService({
        ontologyMode: 'vidak_private',
        ontologyAdapter: privateOntologyAdapter,
        store: new PostgresW3dsPrivateAdapterSyncStore(harness.db),
        mappingService,
      });

      const videoService = new CreatorVideoService({
        store: new PostgresCreatorVideoStore(harness.db),
        resolveUser: async (accessToken) =>
          (await harness.authService.getSession(accessToken)).user,
        privateAdapterSync: sync,
      });
      const mediaService = new MediaAssetService({
        store: new PostgresMediaAssetStore(harness.db),
        storage: new LocalDiskMediaStorage(harness.mediaRoot),
        limits: {
          maxUploadBytes: 1024 * 1024,
          allowedContentTypes: ['video/mp4'],
        },
        resolveUser: async (accessToken) =>
          (await harness.authService.getSession(accessToken)).user,
      });

      const accessToken = await harness.loginAs({
        eName: '@publisher.w3id',
        eVaultId: 'ev_publisher',
        eVaultUri: 'https://evault.example/publisher',
      });

      const draft = await videoService.createDraft(accessToken, {
        title: 'Private sync publish',
        description: 'Integration',
        visibility: 'public',
      });

      const payload = new TextEncoder().encode('sync-bytes');
      await mediaService.uploadToDraft(
        accessToken,
        draft.id,
        {
          contentType: 'video/mp4',
          contentLength: String(payload.byteLength),
          originalFilename: 'clip.mp4',
        },
        chunkedBody(payload, 4),
      );

      const published = await videoService.publishVideo(accessToken, draft.id);
      expect(published.status).toBe('published');
      expect(published.publicVideoId).toBeTruthy();

      const projectionStore = new PostgresW3dsPrivateAdapterSyncStore(harness.db);
      const videoProjection = await projectionStore.getProjection('video', draft.id);
      expect(videoProjection).toBeTruthy();
      expect(videoProjection?.ownership).toBe('vidak_private');
      expect(videoProjection?.schemaId).toBe(VIDAK_PRIVATE_SCHEMA_IDS.Video);
      expect(videoProjection?.payload.status).toBe('published');
      expect(videoProjection?.payload.visibility).toBe('public');
      expect(videoProjection?.payload.ownerEName).toBe('@publisher.w3id');
      expect(videoProjection?.payload.publicVideoId).toBe(published.publicVideoId);
      expect(videoProjection?.payload.thumbnailFileUri).toBeUndefined();

      const channelProjection = await projectionStore.getProjection('channel', published.channelId);
      expect(channelProjection?.schemaId).toBe(VIDAK_PRIVATE_SCHEMA_IDS.Channel);
      expect(videoProjection?.payload.channelId).toBe(channelProjection?.globalId);

      const mapping = await mappingService.getByLocalId('video', draft.id);
      expect(mapping?.schemaId).toBe(VIDAK_PRIVATE_SCHEMA_IDS.Video);
      expect(mapping?.globalId).toBe(videoProjection?.globalId);

      const retry = await sync.syncVideo({
        video: published,
        ownerEName: '@publisher.w3id',
      });
      expect(retry.outcome).toBe('unchanged');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });
});
