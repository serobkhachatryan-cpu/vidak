/**
 * Server-only official Web3 Adapter handleChange outbox seam.
 *
 * Loads P1A Mapping Rules, enqueues idempotent official outbox work, and
 * attempts create/update through an injected official client. Production
 * resolve stays unavailable: missing, rejected, or unavailable configuration
 * fails closed and never reports remote W3DS success. Private adapter
 * projections stay non-interoperable and are never reused as MetaEnvelope IDs.
 */

import { randomUUID } from 'node:crypto';
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
import type { W3dsAdapterEntityType } from './w3ds-adapter-types';
import {
  loadOfficialMappingRules,
  type W3dsMappingRulesDocument,
  W3dsMappingRulesError,
} from './w3ds-mapping-rules';
import { resolveW3dsOfficialAdapterWriteGate } from './w3ds-official-adapter-gate';
import {
  InMemoryW3dsOfficialAdapterOutboxStore,
  PostgresW3dsOfficialAdapterOutboxStore,
  type W3dsOfficialAdapterEntityType,
  type W3dsOfficialAdapterOutboxStore,
} from './w3ds-official-adapter-outbox';
import {
  isAllowedInjectedOfficialEVaultClientSource,
  isSandboxInjectedOfficialEVaultClientSource,
  resolveW3dsOfficialEVaultClient,
  type W3dsOfficialEVaultClient,
} from './w3ds-official-evault-client';
import {
  fromGlobal,
  resolveOwnerENameFromPath,
  toGlobal,
  W3dsOfficialMapperError,
} from './w3ds-official-mapper';
import { isVidakPrivateSchemaId } from './w3ds-private-ontology';

export class W3dsOfficialAdapterError extends Error {
  readonly code: string;

  constructor(message: string, code = 'official_adapter_failed') {
    super(message);
    this.name = 'W3dsOfficialAdapterError';
    this.code = code;
  }
}

export interface OfficialPrivateProjectionLookup {
  getProjectionByGlobalId(globalId: string): Promise<{ globalId: string } | undefined>;
}

export interface W3dsOfficialHandleChangeInput {
  data: Record<string, unknown>;
  tableName: string;
  participants?: readonly string[];
}

export interface W3dsOfficialHandleChangeResult {
  outcome: 'skipped' | 'failed' | 'synced';
  tableName: string;
  entityType?: W3dsOfficialAdapterEntityType;
  localId: string;
  globalId?: string;
  schemaId?: string;
  remoteWrite: 'create' | 'update' | 'none';
  officialEVaultWrites: false;
  metastateEVaultWrites: false;
  remoteW3dsNetworkCalls: false;
  interoperablePublicW3ds: false;
  httpEvaultClientConstructed: false;
  failureReason?: string;
  correlationId?: string;
  outboxId?: string;
}

export interface W3dsOfficialAdapterStatusSnapshot {
  ontologyMode: W3dsOntologyMode | 'unset';
  adapterConfigured: boolean;
  officialEVaultWrites: false;
  metastateEVaultWrites: false;
  remoteW3dsNetworkCalls: false;
  interoperablePublicW3ds: false;
  httpEvaultClientConstructed: false;
  officialEvaultClient: 'unavailable';
}

export interface W3dsOfficialWeb3AdapterOptions {
  ontologyMode: W3dsOntologyMode | null;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  mappingService: W3dsAdapterMappingService;
  outboxStore: W3dsOfficialAdapterOutboxStore;
  /**
   * Test-only Fake. Production omits this and uses resolveW3dsOfficialEVaultClient.
   */
  officialClient?: W3dsOfficialEVaultClient;
  privateProjectionLookup?: OfficialPrivateProjectionLookup;
  mappingDocuments?: readonly unknown[];
  now?: () => number;
  createId?: () => string;
  createCorrelationId?: () => string;
}

const deniedFlags = {
  officialEVaultWrites: false,
  metastateEVaultWrites: false,
  remoteW3dsNetworkCalls: false,
  interoperablePublicW3ds: false,
  httpEvaultClientConstructed: false,
} as const;

export class W3dsOfficialWeb3Adapter {
  private readonly ontologyMode: W3dsOntologyMode | null;
  private readonly ontologyAdapter: W3dsOntologyAdapterConfig | null;
  private readonly mappingService: W3dsAdapterMappingService;
  private readonly outboxStore: W3dsOfficialAdapterOutboxStore;
  private readonly officialClient: W3dsOfficialEVaultClient | undefined;
  private readonly privateProjectionLookup: OfficialPrivateProjectionLookup | undefined;
  private readonly mappingDocuments: readonly unknown[] | undefined;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createCorrelationIdFn: () => string;

  constructor(options: W3dsOfficialWeb3AdapterOptions) {
    this.ontologyMode = options.ontologyMode;
    this.ontologyAdapter = options.ontologyAdapter;
    this.mappingService = options.mappingService;
    this.outboxStore = options.outboxStore;
    this.officialClient = options.officialClient;
    this.privateProjectionLookup = options.privateProjectionLookup;
    this.mappingDocuments = options.mappingDocuments;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => randomUUID());
    this.createCorrelationIdFn = options.createCorrelationId ?? createCorrelationId;
  }

  getStatus(): W3dsOfficialAdapterStatusSnapshot {
    const gate = resolveW3dsOfficialAdapterWriteGate({
      ontologyMode: this.ontologyMode ?? 'vidak_private',
      ontologyAdapter: this.ontologyAdapter,
    });
    return {
      ontologyMode: this.ontologyMode ?? 'unset',
      adapterConfigured: Boolean(this.ontologyAdapter),
      officialEVaultWrites: gate.officialEVaultWrites,
      metastateEVaultWrites: gate.metastateEVaultWrites,
      remoteW3dsNetworkCalls: gate.remoteW3dsNetworkCalls,
      interoperablePublicW3ds: gate.interoperablePublicW3ds,
      httpEvaultClientConstructed: gate.httpEvaultClientConstructed,
      officialEvaultClient: gate.officialEvaultClient,
    };
  }

  async fromGlobal(input: {
    data: Record<string, unknown>;
    mapping: W3dsMappingRulesDocument;
  }): Promise<Record<string, unknown>> {
    return fromGlobal({
      data: input.data,
      mapping: input.mapping,
      mappingService: this.mappingService,
    });
  }

  async handleChange(
    input: W3dsOfficialHandleChangeInput,
  ): Promise<W3dsOfficialHandleChangeResult> {
    const tableName = input.tableName.trim();
    const localIdRaw = typeof input.data.id === 'string' ? input.data.id.trim() : '';
    const base = {
      tableName,
      localId: localIdRaw,
      remoteWrite: 'none' as const,
      ...deniedFlags,
    };

    if (this.ontologyMode !== 'metastate_official') {
      return {
        ...base,
        outcome: 'skipped',
        failureReason:
          'Official handleChange requires W3DS_ONTOLOGY_MODE=metastate_official. The private adapter remains non-interoperable.',
      };
    }

    let documents: readonly W3dsMappingRulesDocument[];
    try {
      documents = loadOfficialMappingRules({
        ontologyMode: this.ontologyMode,
        ontologyAdapter: this.ontologyAdapter,
        ...(this.mappingDocuments ? { documents: this.mappingDocuments } : {}),
      }).documents;
    } catch (error) {
      const failureReason = redactSensitiveText(
        error,
        error instanceof W3dsMappingRulesError
          ? error.message
          : 'Official Mapping Rules are unavailable.',
      );
      return {
        ...base,
        outcome: 'failed',
        failureReason,
        correlationId: this.createCorrelationIdFn(),
      };
    }

    const mapping = documents.find((document) => document.tableName === tableName);
    if (!mapping || mapping.readOnly) {
      return { ...base, outcome: 'skipped' };
    }

    const entityType = mapping.entityType;
    if (!isOfficialOutboxEntity(entityType)) {
      return { ...base, outcome: 'skipped' };
    }

    if (!localIdRaw) {
      return {
        ...base,
        entityType,
        outcome: 'failed',
        failureReason: 'Official handleChange requires a local id.',
      };
    }

    const ownerEName = resolveOwnerENameFromPath(input.data, mapping.ownerEnamePath);
    if (!ownerEName) {
      return {
        ...base,
        entityType,
        schemaId: mapping.schemaId,
        outcome: 'skipped',
        failureReason: 'Official handleChange skipped because ownerEnamePath resolved to nothing.',
      };
    }

    const correlationId = this.createCorrelationIdFn();
    const outbox = await this.outboxStore.upsertOutbox({
      id: this.createId(),
      entityType,
      localId: localIdRaw,
      operation: 'upsert',
      syncStatus: 'pending',
      correlationId,
      now: this.now(),
    });

    try {
      const client = this.resolveClient();
      this.assertWriteGateClosed();

      const existingMapping = await this.mappingService.getByLocalId(entityType, localIdRaw);
      if (existingMapping) {
        await this.assertOfficialMapping(existingMapping.globalId, existingMapping.schemaId);
      }

      const mapped = await toGlobal({
        data: input.data,
        mapping,
        mappingService: this.mappingService,
      });
      if (!mapped.ownerEName) {
        throw new W3dsOfficialAdapterError(
          'Official handleChange skipped because ownerEnamePath resolved to nothing.',
          'missing_owner_ename',
        );
      }

      await client.resolveEvaultUri(mapped.ownerEName);

      if (existingMapping) {
        const updated = await client.updateMetaEnvelope({
          id: existingMapping.globalId,
          ownerEName: mapped.ownerEName,
          schemaId: mapping.schemaId,
          payload: mapped.payload,
        });
        await this.assertOfficialMapping(updated.id, mapping.schemaId);
        await this.outboxStore.markOutboxAttempt({
          id: outbox.id,
          syncStatus: 'synced',
          attemptCount: outbox.attemptCount + 1,
          lastAttemptedAt: new Date(this.now()).toISOString(),
          lastSyncedAt: new Date(this.now()).toISOString(),
          failureReason: null,
          correlationId,
        });
        return {
          ...base,
          outcome: 'synced',
          entityType,
          schemaId: mapping.schemaId,
          globalId: updated.id,
          remoteWrite: 'update',
          correlationId,
          outboxId: outbox.id,
        };
      }

      const created = await client.createMetaEnvelope({
        ownerEName: mapped.ownerEName,
        schemaId: mapping.schemaId,
        payload: mapped.payload,
      });
      await this.assertOfficialMapping(created.id, mapping.schemaId);
      if (created.id === localIdRaw) {
        throw new W3dsOfficialAdapterError(
          'Official handleChange refuses to use the local entity id as a MetaEnvelope id.',
          'local_id_as_meta_envelope',
        );
      }

      await this.mappingService.recordMapping({
        entityType,
        localId: localIdRaw,
        globalId: created.id,
        ownerEName: mapped.ownerEName,
      });

      await this.outboxStore.markOutboxAttempt({
        id: outbox.id,
        syncStatus: 'synced',
        attemptCount: outbox.attemptCount + 1,
        lastAttemptedAt: new Date(this.now()).toISOString(),
        lastSyncedAt: new Date(this.now()).toISOString(),
        failureReason: null,
        correlationId,
      });

      return {
        ...base,
        outcome: 'synced',
        entityType,
        schemaId: mapping.schemaId,
        globalId: created.id,
        remoteWrite: 'create',
        correlationId,
        outboxId: outbox.id,
      };
    } catch (error) {
      const failureReason = redactSensitiveText(error, 'Official handleChange failed.');
      await this.outboxStore.markOutboxAttempt({
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
          error instanceof W3dsOfficialAdapterError ||
          error instanceof W3dsOfficialMapperError ||
          error instanceof W3dsMappingRulesError
            ? error instanceof W3dsOfficialAdapterError || error instanceof W3dsOfficialMapperError
              ? error.code
              : 'mapping_rules'
            : 'official_handle_change',
      });
      return {
        ...base,
        outcome: 'failed',
        entityType,
        schemaId: mapping.schemaId,
        failureReason,
        correlationId,
        outboxId: outbox.id,
      };
    }
  }

  private resolveClient(): W3dsOfficialEVaultClient {
    if (this.officialClient) {
      if (!isAllowedInjectedOfficialEVaultClientSource(this.officialClient.source)) {
        throw new W3dsOfficialAdapterError(
          'Official handleChange refuses a non-fake, non-loopback-sandbox eVault client while HTTP construction is gated off.',
          'http_evault_client_unavailable',
        );
      }
      if (
        isSandboxInjectedOfficialEVaultClientSource(this.officialClient.source) &&
        process.env.W3DS_SANDBOX_COMPAT_ENABLED !== 'true'
      ) {
        throw new W3dsOfficialAdapterError(
          'Official handleChange refuses an injected sandbox eVault client until W3DS_SANDBOX_COMPAT_ENABLED=true. A sandbox:// source string is not authentication.',
          'http_evault_client_unavailable',
        );
      }
      return this.officialClient;
    }

    const resolved = resolveW3dsOfficialEVaultClient();
    if (resolved.status === 'available') {
      throw new W3dsOfficialAdapterError(
        'Official handleChange refuses a production-resolved eVault client until the P1A write gate allows HTTP construction.',
        'http_evault_client_unavailable',
      );
    }
    throw new W3dsOfficialAdapterError(
      `W3DS official eVault client is unavailable: ${resolved.missing.join(' ')}`,
      'http_evault_client_unavailable',
    );
  }

  private assertWriteGateClosed(): void {
    const gate = resolveW3dsOfficialAdapterWriteGate({
      ontologyMode: this.ontologyMode ?? 'vidak_private',
      ontologyAdapter: this.ontologyAdapter,
    });
    if (gate.httpEvaultClientConstructed || gate.allowed || gate.officialEVaultWrites) {
      throw new W3dsOfficialAdapterError(
        'Official handleChange refused because the write gate reported HTTP eVault construction.',
        'http_evault_client_unavailable',
      );
    }
  }

  private async assertOfficialMapping(globalId: string, schemaId: string): Promise<void> {
    if (isVidakPrivateSchemaId(schemaId) || schemaId.startsWith('vidak:private:')) {
      throw new W3dsOfficialAdapterError(
        'Official handleChange refuses Vidak-private schema IDs as MetaEnvelope ontology.',
        'private_schema_id',
      );
    }
    if (this.privateProjectionLookup) {
      const privateHit = await this.privateProjectionLookup.getProjectionByGlobalId(globalId);
      if (privateHit) {
        throw new W3dsOfficialAdapterError(
          'Official handleChange refuses a Vidak-private projection id as a MetaEnvelope id.',
          'private_projection_id',
        );
      }
    }
  }
}

function isOfficialOutboxEntity(
  entityType: W3dsAdapterEntityType,
): entityType is W3dsOfficialAdapterEntityType {
  return (
    entityType === 'channel' ||
    entityType === 'video' ||
    entityType === 'playlist' ||
    entityType === 'comment'
  );
}

let sharedAdapter: W3dsOfficialWeb3Adapter | undefined;

export function createOfficialWeb3Adapter(options: {
  ontologyMode: W3dsOntologyMode | null;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  mappingService?: W3dsAdapterMappingService;
  outboxStore?: W3dsOfficialAdapterOutboxStore;
  officialClient?: W3dsOfficialEVaultClient;
  privateProjectionLookup?: OfficialPrivateProjectionLookup;
}): W3dsOfficialWeb3Adapter {
  const mappingService =
    options.mappingService ??
    new AdapterMappingService({
      store: createPostgresW3dsAdapterMappingStore(getW3dsDatabase()),
      ontologyAdapter: options.ontologyAdapter,
    });
  const outboxStore =
    options.outboxStore ?? new PostgresW3dsOfficialAdapterOutboxStore(getW3dsDatabase());
  return new W3dsOfficialWeb3Adapter({
    ontologyMode: options.ontologyMode,
    ontologyAdapter: options.ontologyAdapter,
    mappingService,
    outboxStore,
    ...(options.officialClient ? { officialClient: options.officialClient } : {}),
    ...(options.privateProjectionLookup
      ? { privateProjectionLookup: options.privateProjectionLookup }
      : {}),
  });
}

export function getOfficialWeb3Adapter(): W3dsOfficialWeb3Adapter {
  if (!sharedAdapter) {
    const config = loadServerSecurityConfig();
    sharedAdapter = createOfficialWeb3Adapter({
      ontologyMode: config.ontologyMode,
      ontologyAdapter: config.w3ds?.ontologyAdapter ?? null,
    });
  }
  return sharedAdapter;
}

export function resetOfficialWeb3AdapterForTests(): void {
  sharedAdapter = undefined;
}

export function createInMemoryOfficialWeb3Adapter(options: {
  ontologyMode: W3dsOntologyMode | null;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  officialClient?: W3dsOfficialEVaultClient;
  privateProjectionLookup?: OfficialPrivateProjectionLookup;
  mappingService?: W3dsAdapterMappingService;
  now?: () => number;
}): {
  adapter: W3dsOfficialWeb3Adapter;
  mappingService: W3dsAdapterMappingService;
  outboxStore: InMemoryW3dsOfficialAdapterOutboxStore;
} {
  const mappingService =
    options.mappingService ??
    new AdapterMappingService({
      store: new InMemoryW3dsAdapterMappingStore(),
      ontologyAdapter: options.ontologyAdapter,
      ...(options.now ? { now: options.now } : {}),
    });
  const outboxStore = new InMemoryW3dsOfficialAdapterOutboxStore();
  const adapter = new W3dsOfficialWeb3Adapter({
    ontologyMode: options.ontologyMode,
    ontologyAdapter: options.ontologyAdapter,
    mappingService,
    outboxStore,
    ...(options.officialClient ? { officialClient: options.officialClient } : {}),
    ...(options.privateProjectionLookup
      ? { privateProjectionLookup: options.privateProjectionLookup }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { adapter, mappingService, outboxStore };
}
