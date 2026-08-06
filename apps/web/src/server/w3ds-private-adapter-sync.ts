/**
 * Vidak-private adapter sync.
 *
 * Durable, idempotent, server-only projections + mappings against the Vidak
 * private ontology catalogue. Never calls MetaState Ontology, MetaState eVault,
 * Awareness, ACL, or remote w3ds://file upload APIs.
 */

import { randomUUID } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { getW3dsDatabase } from './db/client';
import { createCorrelationId, reportOperationalFailure } from './ops-observability';
import { redactSensitiveText } from './ops-redaction';
import {
  loadServerSecurityConfig,
  type W3dsOntologyAdapterConfig,
  type W3dsOntologyMode,
} from './server-config';
import {
  W3dsAdapterMappingService as AdapterMappingService,
  createPostgresW3dsAdapterMappingStore,
  InMemoryW3dsAdapterMappingStore,
  type W3dsAdapterMappingService,
} from './w3ds-adapter-mapping';
import {
  buildChannelProjectionPayload,
  buildCommentProjectionPayload,
  buildPlaylistProjectionPayload,
  buildVideoProjectionPayload,
  privateSchemaIdForEntity,
  W3dsPrivateAdapterProjectionError,
} from './w3ds-private-adapter-project';
import {
  hashPrivateAdapterPayload,
  InMemoryW3dsPrivateAdapterSyncStore,
  PostgresW3dsPrivateAdapterSyncStore,
  type W3dsPrivateAdapterSyncStore,
} from './w3ds-private-adapter-sync-store';
import type {
  PrivateAdapterSyncResult,
  PrivateAdapterSyncStatusSnapshot,
  SyncChannelInput,
  SyncCommentInput,
  SyncPlaylistInput,
  SyncVideoInput,
  W3dsPrivateAdapterEntityType,
} from './w3ds-private-adapter-sync-types';
import {
  getVidakPrivateOntologySchema,
  isVidakPrivateSchemaId,
  VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
  VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
} from './w3ds-private-ontology';

export {
  buildChannelProjectionPayload,
  buildCommentProjectionPayload,
  buildPlaylistProjectionPayload,
  buildVideoProjectionPayload,
  W3dsPrivateAdapterProjectionError,
} from './w3ds-private-adapter-project';
export {
  hashPrivateAdapterPayload,
  InMemoryW3dsPrivateAdapterSyncStore,
  PostgresW3dsPrivateAdapterSyncStore,
} from './w3ds-private-adapter-sync-store';
export type {
  PrivateAdapterSyncResult,
  PrivateAdapterSyncStatusSnapshot,
  SyncChannelInput,
  SyncCommentInput,
  SyncPlaylistInput,
  SyncVideoInput,
} from './w3ds-private-adapter-sync-types';

export class W3dsPrivateAdapterSyncError extends Error {
  readonly code: string;

  constructor(message: string, code = 'private_adapter_sync_failed') {
    super(message);
    this.name = 'W3dsPrivateAdapterSyncError';
    this.code = code;
  }
}

export interface W3dsPrivateAdapterSyncServiceOptions {
  store: W3dsPrivateAdapterSyncStore;
  mappingService: W3dsAdapterMappingService;
  ontologyMode: W3dsOntologyMode | null;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  now?: () => number;
  createId?: () => string;
  createCorrelationId?: () => string;
}

/**
 * True only when Vidak-private catalogue mode is active and the ontology
 * adapter is explicitly enabled with configured schema metadata.
 */
export function isVidakPrivateAdapterSyncEnabled(input: {
  ontologyMode: W3dsOntologyMode | null | undefined;
  ontologyAdapter: W3dsOntologyAdapterConfig | null | undefined;
}): boolean {
  return input.ontologyMode === 'vidak_private' && Boolean(input.ontologyAdapter);
}

function createSchemaValidators(): Map<W3dsPrivateAdapterEntityType, ValidateFunction> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const map = new Map<W3dsPrivateAdapterEntityType, ValidateFunction>();
  for (const entityType of ['channel', 'video', 'playlist', 'comment'] as const) {
    const schemaId = privateSchemaIdForEntity(entityType);
    const document = getVidakPrivateOntologySchema(schemaId);
    if (!document.ok) {
      throw new Error(`Private ontology schema missing for ${entityType}`);
    }
    map.set(entityType, ajv.compile(document.schema));
  }
  return map;
}

const schemaValidators = createSchemaValidators();

export class W3dsPrivateAdapterSyncService {
  private readonly store: W3dsPrivateAdapterSyncStore;
  private readonly mappingService: W3dsAdapterMappingService;
  private readonly ontologyMode: W3dsOntologyMode | null;
  private readonly ontologyAdapter: W3dsOntologyAdapterConfig | null;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createCorrelationIdFn: () => string;

  constructor(options: W3dsPrivateAdapterSyncServiceOptions) {
    this.store = options.store;
    this.mappingService = options.mappingService;
    this.ontologyMode = options.ontologyMode;
    this.ontologyAdapter = options.ontologyAdapter;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => randomUUID());
    this.createCorrelationIdFn = options.createCorrelationId ?? createCorrelationId;
  }

  /** Safe status snapshot — never includes secrets or payload data. */
  getStatus(): PrivateAdapterSyncStatusSnapshot {
    return {
      enabled: isVidakPrivateAdapterSyncEnabled({
        ontologyMode: this.ontologyMode,
        ontologyAdapter: this.ontologyAdapter,
      }),
      ontologyMode: this.ontologyMode ?? 'unset',
      adapterConfigured: Boolean(this.ontologyAdapter),
      ownership: VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
      catalogueVisibility: VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
      interoperablePublicW3ds: false,
      metastateOntologyCalls: false,
      metastateEVaultWrites: false,
      remoteW3dsNetworkCalls: false,
    };
  }

  isEnabled(): boolean {
    return isVidakPrivateAdapterSyncEnabled({
      ontologyMode: this.ontologyMode,
      ontologyAdapter: this.ontologyAdapter,
    });
  }

  async syncChannel(input: SyncChannelInput): Promise<PrivateAdapterSyncResult> {
    return this.runUpsert('channel', input.channel.id, async (globalId) =>
      buildChannelProjectionPayload(input, globalId),
    );
  }

  async syncVideo(input: SyncVideoInput): Promise<PrivateAdapterSyncResult> {
    return this.runUpsert('video', input.video.id, async (globalId) => {
      const channelMapping = await this.mappingService.getByLocalId(
        'channel',
        input.video.channelId,
      );
      if (!channelMapping) {
        throw new W3dsPrivateAdapterProjectionError(
          'Video sync requires a prior private channel projection mapping.',
          'missing_channel_mapping',
        );
      }
      return buildVideoProjectionPayload(input, globalId, channelMapping.globalId);
    });
  }

  /**
   * Playlist sync for when playlists become durable. No product lifecycle hook
   * until a playlists table exists.
   */
  async syncPlaylist(input: SyncPlaylistInput): Promise<PrivateAdapterSyncResult> {
    return this.runUpsert('playlist', input.playlist.id, async (globalId) => {
      const channelMapping = await this.mappingService.getByLocalId(
        'channel',
        input.playlist.channelId,
      );
      if (!channelMapping) {
        throw new W3dsPrivateAdapterProjectionError(
          'Playlist sync requires a prior private channel projection mapping.',
          'missing_channel_mapping',
        );
      }
      const videoGlobalIds = new Map<string, string>();
      for (const item of input.playlist.items ?? []) {
        const mapped = await this.mappingService.getByLocalId('video', item.videoId);
        if (!mapped) {
          throw new W3dsPrivateAdapterProjectionError(
            `Playlist item video ${item.videoId} has no private projection mapping.`,
            'missing_video_mapping',
          );
        }
        videoGlobalIds.set(item.videoId, mapped.globalId);
      }
      return buildPlaylistProjectionPayload(
        input,
        globalId,
        channelMapping.globalId,
        videoGlobalIds,
      );
    });
  }

  /**
   * Comment sync for when comments become durable. No product lifecycle hook
   * until a comments table exists.
   */
  async syncComment(input: SyncCommentInput): Promise<PrivateAdapterSyncResult> {
    return this.runUpsert('comment', input.comment.id, async (globalId) => {
      const videoMapping = await this.mappingService.getByLocalId('video', input.comment.videoId);
      if (!videoMapping) {
        throw new W3dsPrivateAdapterProjectionError(
          'Comment sync requires a prior private video projection mapping.',
          'missing_video_mapping',
        );
      }
      let parentGlobalId: string | undefined;
      if (input.comment.parentId) {
        const parentMapping = await this.mappingService.getByLocalId(
          'comment',
          input.comment.parentId,
        );
        if (!parentMapping) {
          throw new W3dsPrivateAdapterProjectionError(
            'Comment parent requires a prior private comment projection mapping.',
            'missing_comment_mapping',
          );
        }
        parentGlobalId = parentMapping.globalId;
      }
      return buildCommentProjectionPayload(input, globalId, videoMapping.globalId, parentGlobalId);
    });
  }

  /**
   * Fail-soft wrapper for product mutations. Never throws; reports redacted
   * operational failures when sync is enabled and processing fails.
   */
  async syncChannelSafe(input: SyncChannelInput): Promise<PrivateAdapterSyncResult> {
    try {
      return await this.syncChannel(input);
    } catch (error) {
      return this.captureSafeFailure('channel', input.channel.id, error);
    }
  }

  async syncVideoSafe(input: SyncVideoInput): Promise<PrivateAdapterSyncResult> {
    try {
      return await this.syncVideo(input);
    } catch (error) {
      return this.captureSafeFailure('video', input.video.id, error);
    }
  }

  private captureSafeFailure(
    entityType: W3dsPrivateAdapterEntityType,
    localId: string,
    error: unknown,
  ): PrivateAdapterSyncResult {
    const correlationId = this.createCorrelationIdFn();
    reportOperationalFailure({
      category: 'w3ds_sync',
      error,
      correlationId,
      code: 'private_adapter_sync',
    });
    return {
      outcome: 'failed',
      entityType,
      localId,
      ownership: VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
      catalogueVisibility: VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
      interoperablePublicW3ds: false,
      failureReason: redactSensitiveText(error, 'Private adapter sync failed.'),
      correlationId,
    };
  }

  private async runUpsert(
    entityType: W3dsPrivateAdapterEntityType,
    localIdRaw: string,
    buildPayload: (globalId: string) => Promise<Record<string, unknown>>,
  ): Promise<PrivateAdapterSyncResult> {
    const localId = localIdRaw?.trim();
    const baseResult = {
      entityType,
      localId: localId || '',
      ownership: VIDAK_PRIVATE_ONTOLOGY_OWNERSHIP,
      catalogueVisibility: VIDAK_PRIVATE_ONTOLOGY_VISIBILITY,
      interoperablePublicW3ds: false as const,
    };

    if (!this.isEnabled()) {
      return { ...baseResult, outcome: 'skipped' };
    }

    if (!localId) {
      throw new W3dsPrivateAdapterSyncError(
        'Private adapter sync requires a local id.',
        'invalid_entity',
      );
    }

    const ontology = this.requirePrivateOntologyAdapter();
    const schemaId = ontology.schemaIds[entityType];
    if (!isVidakPrivateSchemaId(schemaId)) {
      throw new W3dsPrivateAdapterSyncError(
        `Private adapter sync rejects non-Vidak schema IDs for ${entityType}.`,
        'invalid_schema_id',
      );
    }
    if (schemaId !== privateSchemaIdForEntity(entityType)) {
      throw new W3dsPrivateAdapterSyncError(
        `Private adapter sync schemaId for ${entityType} must match the private catalogue.`,
        'invalid_schema_id',
      );
    }

    const correlationId = this.createCorrelationIdFn();
    const outbox = await this.store.upsertOutbox({
      id: this.createId(),
      entityType,
      localId,
      operation: 'upsert',
      syncStatus: 'pending',
      correlationId,
      now: this.now(),
    });

    try {
      const existingMapping = await this.mappingService.getByLocalId(entityType, localId);
      const existingProjection = await this.store.getProjection(entityType, localId);
      const globalId = existingMapping?.globalId ?? existingProjection?.globalId ?? this.createId();

      const payload = await buildPayload(globalId);
      this.validatePayload(entityType, payload);

      const ownerEName = String(payload.ownerEName);
      const payloadHash = hashPrivateAdapterPayload(payload);

      if (
        existingProjection &&
        existingProjection.payloadHash === payloadHash &&
        existingProjection.globalId === globalId
      ) {
        await this.store.markOutboxAttempt({
          id: outbox.id,
          syncStatus: 'synced',
          attemptCount: outbox.attemptCount + 1,
          lastAttemptedAt: new Date(this.now()).toISOString(),
          lastSyncedAt: new Date(this.now()).toISOString(),
          failureReason: null,
          correlationId,
        });
        return {
          ...baseResult,
          outcome: 'unchanged',
          globalId,
          schemaId,
          correlationId,
        };
      }

      const projection = await this.store.upsertProjection({
        entityType,
        localId,
        globalId,
        schemaId,
        ownerEName,
        payload,
        payloadHash,
        mappingVersion: ontology.mappingVersion,
        now: this.now(),
      });

      await this.mappingService.recordMapping({
        entityType,
        localId,
        globalId: projection.globalId,
        ownerEName,
      });

      await this.store.markOutboxAttempt({
        id: outbox.id,
        syncStatus: 'synced',
        attemptCount: outbox.attemptCount + 1,
        lastAttemptedAt: new Date(this.now()).toISOString(),
        lastSyncedAt: new Date(this.now()).toISOString(),
        failureReason: null,
        correlationId,
      });

      return {
        ...baseResult,
        outcome: 'synced',
        globalId: projection.globalId,
        schemaId,
        correlationId,
      };
    } catch (error) {
      const failureReason = redactSensitiveText(error, 'Private adapter sync failed.');
      await this.store.markOutboxAttempt({
        id: outbox.id,
        syncStatus: 'failed',
        attemptCount: outbox.attemptCount + 1,
        lastAttemptedAt: new Date(this.now()).toISOString(),
        failureReason,
        correlationId,
      });
      reportOperationalFailure({
        category: 'w3ds_sync',
        error,
        correlationId,
        code:
          error instanceof W3dsPrivateAdapterProjectionError ||
          error instanceof W3dsPrivateAdapterSyncError
            ? error.code
            : 'private_adapter_sync',
      });
      throw error instanceof W3dsPrivateAdapterSyncError ||
        error instanceof W3dsPrivateAdapterProjectionError
        ? error
        : new W3dsPrivateAdapterSyncError(failureReason, 'private_adapter_sync_failed');
    }
  }

  private requirePrivateOntologyAdapter(): W3dsOntologyAdapterConfig {
    if (this.ontologyMode !== 'vidak_private') {
      throw new W3dsPrivateAdapterSyncError(
        'Vidak-private adapter sync requires W3DS_ONTOLOGY_MODE=vidak_private.',
        'ontology_mode_disabled',
      );
    }
    if (!this.ontologyAdapter) {
      throw new W3dsPrivateAdapterSyncError(
        'Vidak-private adapter sync requires W3DS_ONTOLOGY_ADAPTER_ENABLED=true with private catalogue schema IDs.',
        'adapter_disabled',
      );
    }
    return this.ontologyAdapter;
  }

  private validatePayload(
    entityType: W3dsPrivateAdapterEntityType,
    payload: Record<string, unknown>,
  ): void {
    const validate = schemaValidators.get(entityType);
    if (!validate) {
      throw new W3dsPrivateAdapterSyncError(
        `No private schema validator for ${entityType}.`,
        'invalid_schema_id',
      );
    }
    if (!validate(payload)) {
      const detail = validate.errors?.[0]
        ? `${validate.errors[0].instancePath || '/'} ${validate.errors[0].message ?? 'invalid'}`
        : 'payload failed schema validation';
      throw new W3dsPrivateAdapterProjectionError(
        `Invalid ${entityType} private projection: ${detail}`,
        'invalid_entity',
      );
    }
  }
}

let sharedService: W3dsPrivateAdapterSyncService | undefined;

export function createVidakPrivateAdapterSyncService(options: {
  ontologyMode: W3dsOntologyMode | null;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  store?: W3dsPrivateAdapterSyncStore;
  mappingService?: W3dsAdapterMappingService;
}): W3dsPrivateAdapterSyncService {
  const mappingService =
    options.mappingService ??
    new AdapterMappingService({
      store: createPostgresW3dsAdapterMappingStore(getW3dsDatabase()),
      ontologyAdapter: options.ontologyAdapter,
    });
  const store = options.store ?? new PostgresW3dsPrivateAdapterSyncStore(getW3dsDatabase());
  return new W3dsPrivateAdapterSyncService({
    store,
    mappingService,
    ontologyMode: options.ontologyMode,
    ontologyAdapter: options.ontologyAdapter,
  });
}

/** Shared Node server wiring — fail-closed / skipped when private sync is off. */
export function getVidakPrivateAdapterSyncService(): W3dsPrivateAdapterSyncService {
  if (!sharedService) {
    const config = loadServerSecurityConfig();
    sharedService = createVidakPrivateAdapterSyncService({
      ontologyMode: config.ontologyMode,
      ontologyAdapter: config.w3ds?.ontologyAdapter ?? null,
    });
  }
  return sharedService;
}

export function resetVidakPrivateAdapterSyncServiceForTests(): void {
  sharedService = undefined;
}

/** Test helper: fully in-memory private sync stack. */
export function createInMemoryVidakPrivateAdapterSyncService(options: {
  ontologyMode: W3dsOntologyMode | null;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  now?: () => number;
}): W3dsPrivateAdapterSyncService {
  const mappingStore = new InMemoryW3dsAdapterMappingStore();
  const mappingService = new AdapterMappingService({
    store: mappingStore,
    ontologyAdapter: options.ontologyAdapter,
    ...(options.now ? { now: options.now } : {}),
  });
  return new W3dsPrivateAdapterSyncService({
    store: new InMemoryW3dsPrivateAdapterSyncStore(),
    mappingService,
    ontologyMode: options.ontologyMode,
    ontologyAdapter: options.ontologyAdapter,
    ...(options.now ? { now: options.now } : {}),
  });
}
