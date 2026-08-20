import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getW3dsDatabase, type W3dsDatabase } from './db/client';
import { w3dsAdapterMappings } from './db/schema';
import type { W3dsOntologyAdapterConfig } from './server-config';
import type { W3dsAdapterEntityType } from './w3ds-adapter-types';

export type { W3dsAdapterEntityType };

/**
 * Local table names used by Mapping Rules `tableName` / Web3 Adapter configs.
 * Playlist and comment tables are reserved until those product tables exist.
 */
export const W3DS_ADAPTER_ENTITY_TABLES = {
  profile: 'w3ds_platform_users',
  channel: 'creator_channels',
  video: 'videos',
  playlist: 'playlists',
  comment: 'comments',
} as const satisfies Record<W3dsAdapterEntityType, string>;

/** Reverse lookup used by Mapping Rules `tableName`. */
export function entityTypeForAdapterTable(tableName: string): W3dsAdapterEntityType | undefined {
  const match = (
    Object.entries(W3DS_ADAPTER_ENTITY_TABLES) as Array<[W3dsAdapterEntityType, string]>
  ).find(([, name]) => name === tableName);
  return match?.[0];
}

const eNamePattern = /^@[^\s@]+$/;

export class W3dsAdapterMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W3dsAdapterMappingError';
  }
}

/** Durable local↔global MetaEnvelope mapping. Server-only. */
export interface W3dsAdapterMappingRecord {
  id: string;
  entityType: W3dsAdapterEntityType;
  entityTable: string;
  localId: string;
  globalId: string;
  ownerEName: string;
  schemaId: string;
  mappingVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertW3dsAdapterMappingInput {
  entityType: W3dsAdapterEntityType;
  entityTable: string;
  localId: string;
  globalId: string;
  ownerEName: string;
  schemaId: string;
  mappingVersion: number;
  now: number;
}

/**
 * Web3 Adapter MappingDatabase equivalent on PostgreSQL.
 * Production uses Postgres; in-memory exists only for unit tests.
 */
export interface W3dsAdapterMappingStore {
  getByLocalId(
    entityType: W3dsAdapterEntityType,
    localId: string,
  ): Promise<W3dsAdapterMappingRecord | undefined>;
  getByGlobalId(globalId: string): Promise<W3dsAdapterMappingRecord | undefined>;
  /**
   * Idempotent insert for (entityType, localId) ↔ globalId.
   * Same pair returns the existing row; conflicting IDs fail closed.
   */
  upsertMapping(input: UpsertW3dsAdapterMappingInput): Promise<W3dsAdapterMappingRecord>;
}

function cloneRecord(record: W3dsAdapterMappingRecord): W3dsAdapterMappingRecord {
  return { ...record };
}

function recordFromRow(row: {
  id: string;
  entityType: W3dsAdapterEntityType;
  entityTable: string;
  localId: string;
  globalId: string;
  ownerEName: string;
  schemaId: string;
  mappingVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): W3dsAdapterMappingRecord {
  return {
    id: row.id,
    entityType: row.entityType,
    entityTable: row.entityTable,
    localId: row.localId,
    globalId: row.globalId,
    ownerEName: row.ownerEName,
    schemaId: row.schemaId,
    mappingVersion: row.mappingVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertCompatibleMapping(
  existing: W3dsAdapterMappingRecord,
  input: UpsertW3dsAdapterMappingInput,
): void {
  if (existing.globalId !== input.globalId) {
    throw new W3dsAdapterMappingError(
      `Local ${input.entityType}/${input.localId} is already mapped to MetaEnvelope ${existing.globalId}.`,
    );
  }
  if (existing.entityType !== input.entityType || existing.localId !== input.localId) {
    throw new W3dsAdapterMappingError(
      `MetaEnvelope ${input.globalId} is already mapped to ${existing.entityType}/${existing.localId}.`,
    );
  }
  if (existing.ownerEName !== input.ownerEName) {
    throw new W3dsAdapterMappingError(
      `Mapping for ${input.entityType}/${input.localId} cannot change owner eName.`,
    );
  }
  if (existing.schemaId !== input.schemaId) {
    throw new W3dsAdapterMappingError(
      `Mapping for ${input.entityType}/${input.localId} cannot change ontology schemaId.`,
    );
  }
}

/** In-memory store for explicit unit tests only. */
export class InMemoryW3dsAdapterMappingStore implements W3dsAdapterMappingStore {
  private readonly records = new Map<string, W3dsAdapterMappingRecord>();

  async getByLocalId(
    entityType: W3dsAdapterEntityType,
    localId: string,
  ): Promise<W3dsAdapterMappingRecord | undefined> {
    const found = [...this.records.values()].find(
      (record) => record.entityType === entityType && record.localId === localId,
    );
    return found ? cloneRecord(found) : undefined;
  }

  async getByGlobalId(globalId: string): Promise<W3dsAdapterMappingRecord | undefined> {
    const found = [...this.records.values()].find((record) => record.globalId === globalId);
    return found ? cloneRecord(found) : undefined;
  }

  async upsertMapping(input: UpsertW3dsAdapterMappingInput): Promise<W3dsAdapterMappingRecord> {
    const byLocal = await this.getByLocalId(input.entityType, input.localId);
    const byGlobal = await this.getByGlobalId(input.globalId);

    if (byLocal) {
      assertCompatibleMapping(byLocal, input);
      return cloneRecord(byLocal);
    }
    if (byGlobal) {
      assertCompatibleMapping(byGlobal, input);
      return cloneRecord(byGlobal);
    }

    const created: W3dsAdapterMappingRecord = {
      id: randomUUID(),
      entityType: input.entityType,
      entityTable: input.entityTable,
      localId: input.localId,
      globalId: input.globalId,
      ownerEName: input.ownerEName,
      schemaId: input.schemaId,
      mappingVersion: input.mappingVersion,
      createdAt: new Date(input.now).toISOString(),
      updatedAt: new Date(input.now).toISOString(),
    };
    this.records.set(created.id, created);
    return cloneRecord(created);
  }
}

/** PostgreSQL-backed MappingDatabase used by the Node server. */
export class PostgresW3dsAdapterMappingStore implements W3dsAdapterMappingStore {
  constructor(private readonly db: W3dsDatabase) {}

  async getByLocalId(
    entityType: W3dsAdapterEntityType,
    localId: string,
  ): Promise<W3dsAdapterMappingRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsAdapterMappings)
      .where(
        and(
          eq(w3dsAdapterMappings.entityType, entityType),
          eq(w3dsAdapterMappings.localId, localId),
        ),
      )
      .limit(1);
    return row ? recordFromRow(row) : undefined;
  }

  async getByGlobalId(globalId: string): Promise<W3dsAdapterMappingRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(w3dsAdapterMappings)
      .where(eq(w3dsAdapterMappings.globalId, globalId))
      .limit(1);
    return row ? recordFromRow(row) : undefined;
  }

  async upsertMapping(input: UpsertW3dsAdapterMappingInput): Promise<W3dsAdapterMappingRecord> {
    const byLocal = await this.getByLocalId(input.entityType, input.localId);
    const byGlobal = await this.getByGlobalId(input.globalId);

    if (byLocal) {
      assertCompatibleMapping(byLocal, input);
      return byLocal;
    }
    if (byGlobal) {
      assertCompatibleMapping(byGlobal, input);
      return byGlobal;
    }

    const [created] = await this.db
      .insert(w3dsAdapterMappings)
      .values({
        id: randomUUID(),
        entityType: input.entityType,
        entityTable: input.entityTable,
        localId: input.localId,
        globalId: input.globalId,
        ownerEName: input.ownerEName,
        schemaId: input.schemaId,
        mappingVersion: input.mappingVersion,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      })
      .onConflictDoNothing()
      .returning();

    if (created) return recordFromRow(created);

    // Concurrent insert won; re-read and enforce compatibility.
    const raced =
      (await this.getByLocalId(input.entityType, input.localId)) ??
      (await this.getByGlobalId(input.globalId));
    if (!raced) {
      throw new W3dsAdapterMappingError('Unable to persist the adapter ID mapping.');
    }
    assertCompatibleMapping(raced, input);
    return raced;
  }
}

export interface RecordW3dsAdapterMappingInput {
  entityType: W3dsAdapterEntityType;
  localId: string;
  globalId: string;
  ownerEName: string;
}

export interface W3dsAdapterMappingServiceOptions {
  store: W3dsAdapterMappingStore;
  /**
   * Ontology + schemaId configuration. Null means adapter mapping writes fail
   * closed until operators supply documented Ontology endpoint and schema IDs.
   */
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  now?: () => number;
}

/**
 * Server-only Web3 Adapter mapping foundation.
 *
 * Persists (localId, globalId) pairs with owner eName and schemaId. Does not
 * call eVault, Registry, Ontology, or Awareness — outbound sync and webhooks
 * remain later phases. Schema IDs always come from configured ontology metadata.
 */
export class W3dsAdapterMappingService {
  private readonly store: W3dsAdapterMappingStore;
  private readonly ontologyAdapter: W3dsOntologyAdapterConfig | null;
  private readonly now: () => number;

  constructor(options: W3dsAdapterMappingServiceOptions) {
    this.store = options.store;
    this.ontologyAdapter = options.ontologyAdapter;
    this.now = options.now ?? Date.now;
  }

  /** Fail closed until Ontology base URL and schemaIds are configured. */
  requireOntologyAdapter(): W3dsOntologyAdapterConfig {
    if (!this.ontologyAdapter) {
      throw new W3dsAdapterMappingError(
        'Ontology adapter mappings are unavailable until W3DS_ONTOLOGY_ADAPTER_ENABLED is true and W3DS_ONTOLOGY_BASE_URL plus all W3DS_ONTOLOGY_SCHEMA_ID_* values are supplied. Schema IDs must not be guessed.',
      );
    }
    return this.ontologyAdapter;
  }

  resolveSchemaId(entityType: W3dsAdapterEntityType): string {
    return this.requireOntologyAdapter().schemaIds[entityType];
  }

  resolveEntityTable(entityType: W3dsAdapterEntityType): string {
    return W3DS_ADAPTER_ENTITY_TABLES[entityType];
  }

  async getByLocalId(
    entityType: W3dsAdapterEntityType,
    localId: string,
  ): Promise<W3dsAdapterMappingRecord | undefined> {
    return this.store.getByLocalId(entityType, localId);
  }

  async getByGlobalId(globalId: string): Promise<W3dsAdapterMappingRecord | undefined> {
    return this.store.getByGlobalId(globalId);
  }

  /**
   * Records a durable mapping after a successful remote MetaEnvelope write
   * (or inbound Awareness apply). Requires configured schemaIds; never invents them.
   */
  async recordMapping(input: RecordW3dsAdapterMappingInput): Promise<W3dsAdapterMappingRecord> {
    const ontology = this.requireOntologyAdapter();
    const localId = input.localId.trim();
    const globalId = input.globalId.trim();
    const ownerEName = input.ownerEName.trim();

    if (!localId) {
      throw new W3dsAdapterMappingError('Adapter mappings require a non-empty localId.');
    }
    if (!globalId) {
      throw new W3dsAdapterMappingError(
        'Adapter mappings require a non-empty global MetaEnvelope id.',
      );
    }
    if (!eNamePattern.test(ownerEName)) {
      throw new W3dsAdapterMappingError(
        'Adapter mappings require a valid owner eName (e.g. @user.w3id).',
      );
    }

    return this.store.upsertMapping({
      entityType: input.entityType,
      entityTable: this.resolveEntityTable(input.entityType),
      localId,
      globalId,
      ownerEName,
      schemaId: ontology.schemaIds[input.entityType],
      mappingVersion: ontology.mappingVersion,
      now: this.now(),
    });
  }
}

/** Default Postgres-backed store for Node server wiring. */
export function createPostgresW3dsAdapterMappingStore(
  db: W3dsDatabase = getW3dsDatabase(),
): PostgresW3dsAdapterMappingStore {
  return new PostgresW3dsAdapterMappingStore(db);
}
