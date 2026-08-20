/**
 * Server-only Mapping Rules loader for the official Web3 Adapter.
 *
 * Loads versioned JSON from this package (the mapping-contract field maps) and
 * injects schemaId from Ontology adapter configuration. Never calls Ontology,
 * eVault, or Registry. Never reports remote W3DS success.
 */

import type { W3dsOntologyAdapterConfig, W3dsOntologyMode } from './server-config';
import { entityTypeForAdapterTable, W3DS_ADAPTER_ENTITY_TABLES } from './w3ds-adapter-mapping';
import type { W3dsAdapterEntityType } from './w3ds-adapter-types';
import commentsMapping from './w3ds-mapping-rules/v1/comments.json';
import channelMapping from './w3ds-mapping-rules/v1/creator_channels.json';
import playlistsMapping from './w3ds-mapping-rules/v1/playlists.json';
import videosMapping from './w3ds-mapping-rules/v1/videos.json';
import { resolveW3dsOfficialAdapterWriteGate } from './w3ds-official-adapter-gate';
import {
  assertAllowedOfficialSchemaId,
  isDisallowedPlaceholderSchemaId,
  W3dsSchemaIdPolicyError,
} from './w3ds-schema-id-policy';

export const W3DS_OFFICIAL_MAPPING_RULES_VERSION = 1;

const REQUIRED_OFFICIAL_MAPPING_TABLES = [
  W3DS_ADAPTER_ENTITY_TABLES.channel,
  W3DS_ADAPTER_ENTITY_TABLES.video,
  W3DS_ADAPTER_ENTITY_TABLES.playlist,
  W3DS_ADAPTER_ENTITY_TABLES.comment,
] as const;

const ALLOWED_MAPPING_KEYS = new Set([
  'tableName',
  'schemaId',
  'ownerEnamePath',
  'ownedJunctionTables',
  'readOnly',
  'localToUniversalMap',
]);

/** Documented Mapping Rules directives from platform.md — do not invent new ones. */
const DIRECT_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATE_DIRECTIVE = /^__date\(.+\)$/;
const FILE_DIRECTIVE = /^__file\(.+\)(?:,[A-Za-z_][A-Za-z0-9_]*)?$/;
const CALC_DIRECTIVE = /^__calc\(.+\)$/;
const RELATION_DIRECTIVE = /^[A-Za-z_][A-Za-z0-9_]*\(.+\),[A-Za-z_][A-Za-z0-9_]*$/;
const OWNER_ENAME_PATH =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\([^)]+\))?(?:\s*\|\|\s*[A-Za-z_][A-Za-z0-9_]*(?:\([^)]+\))?)*$/;

export class W3dsMappingRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'W3dsMappingRulesError';
  }
}

/** Resolved Mapping Rules document. schemaId is always from configuration. */
export interface W3dsMappingRulesDocument {
  tableName: string;
  entityType: W3dsAdapterEntityType;
  schemaId: string;
  ownerEnamePath: string;
  localToUniversalMap: Record<string, string>;
  readOnly?: boolean;
  ownedJunctionTables?: string[];
}

export interface LoadOfficialMappingRulesInput {
  ontologyMode: W3dsOntologyMode;
  ontologyAdapter: W3dsOntologyAdapterConfig | null;
  /** Injectable documents for tests. Production uses bundled v1 files. */
  documents?: readonly unknown[];
}

export interface OfficialMappingRulesLoadResult {
  mappingVersion: number;
  documents: readonly W3dsMappingRulesDocument[];
  officialEVaultWrites: false;
  metastateEVaultWrites: false;
  remoteW3dsNetworkCalls: false;
  interoperablePublicW3ds: false;
  httpEvaultClientConstructed: false;
}

export function bundledOfficialMappingRuleSources(): readonly unknown[] {
  return [videosMapping, channelMapping, playlistsMapping, commentsMapping];
}

export function loadOfficialMappingRules(
  input: LoadOfficialMappingRulesInput,
): OfficialMappingRulesLoadResult {
  if (input.ontologyMode !== 'metastate_official') {
    throw new W3dsMappingRulesError(
      'Official Mapping Rules load requires W3DS_ONTOLOGY_MODE=metastate_official.',
    );
  }
  if (!input.ontologyAdapter) {
    throw new W3dsMappingRulesError(
      'Official Mapping Rules load requires W3DS_ONTOLOGY_ADAPTER_ENABLED=true and every W3DS_ONTOLOGY_SCHEMA_ID_*. Schema IDs must not be guessed.',
    );
  }

  const mappingVersion = input.ontologyAdapter.mappingVersion;
  if (mappingVersion !== W3DS_OFFICIAL_MAPPING_RULES_VERSION && !input.documents) {
    throw new W3dsMappingRulesError(
      `Official Mapping Rules version ${mappingVersion} is not available. Bundled rules are version ${W3DS_OFFICIAL_MAPPING_RULES_VERSION}.`,
    );
  }

  const sources = input.documents ?? bundledOfficialMappingRuleSources();
  const resolved: W3dsMappingRulesDocument[] = [];
  const seenTables = new Set<string>();

  for (const source of sources) {
    const document = resolveOfficialMappingDocument(source, input.ontologyAdapter);
    if (seenTables.has(document.tableName)) {
      throw new W3dsMappingRulesError(
        `Official Mapping Rules include a duplicate tableName "${document.tableName}".`,
      );
    }
    seenTables.add(document.tableName);
    resolved.push(document);
  }

  for (const tableName of REQUIRED_OFFICIAL_MAPPING_TABLES) {
    if (!seenTables.has(tableName)) {
      throw new W3dsMappingRulesError(
        `Official Mapping Rules are missing the required table "${tableName}".`,
      );
    }
  }

  const writeGate = resolveW3dsOfficialAdapterWriteGate({
    ontologyMode: input.ontologyMode,
    ontologyAdapter: input.ontologyAdapter,
  });

  return {
    mappingVersion: W3DS_OFFICIAL_MAPPING_RULES_VERSION,
    documents: resolved,
    officialEVaultWrites: writeGate.officialEVaultWrites,
    metastateEVaultWrites: writeGate.metastateEVaultWrites,
    remoteW3dsNetworkCalls: writeGate.remoteW3dsNetworkCalls,
    interoperablePublicW3ds: writeGate.interoperablePublicW3ds,
    httpEvaultClientConstructed: writeGate.httpEvaultClientConstructed,
  };
}

function resolveOfficialMappingDocument(
  source: unknown,
  ontologyAdapter: W3dsOntologyAdapterConfig,
): W3dsMappingRulesDocument {
  if (!isRecord(source)) {
    throw new W3dsMappingRulesError('Official Mapping Rules document must be a JSON object.');
  }

  for (const key of Object.keys(source)) {
    if (!ALLOWED_MAPPING_KEYS.has(key)) {
      throw new W3dsMappingRulesError(
        `Official Mapping Rules include undocumented key "${key}". Do not invent mapping syntax.`,
      );
    }
  }

  const tableName = requiredString(source.tableName, 'tableName');
  const entityType = entityTypeForAdapterTable(tableName);
  if (!entityType || entityType === 'profile') {
    throw new W3dsMappingRulesError(
      `Official Mapping Rules tableName "${tableName}" is not a configured adapter table.`,
    );
  }

  const ownerEnamePath = requiredString(source.ownerEnamePath, 'ownerEnamePath');
  if (!OWNER_ENAME_PATH.test(ownerEnamePath)) {
    throw new W3dsMappingRulesError(
      `Official Mapping Rules ownerEnamePath "${ownerEnamePath}" is not documented mapping syntax.`,
    );
  }

  const localToUniversalMap = source.localToUniversalMap;
  if (!isRecord(localToUniversalMap) || Object.keys(localToUniversalMap).length === 0) {
    throw new W3dsMappingRulesError(
      `Official Mapping Rules for "${tableName}" require localToUniversalMap.`,
    );
  }
  const resolvedMap: Record<string, string> = {};
  for (const [localField, mapping] of Object.entries(localToUniversalMap)) {
    if (typeof mapping !== 'string' || !mapping.trim()) {
      throw new W3dsMappingRulesError(
        `Official Mapping Rules field "${localField}" on "${tableName}" must map to a string directive.`,
      );
    }
    if (!isDocumentedMappingDirective(mapping)) {
      throw new W3dsMappingRulesError(
        `Official Mapping Rules field "${localField}" on "${tableName}" uses undocumented directive "${mapping}".`,
      );
    }
    resolvedMap[localField] = mapping;
  }

  const configuredSchemaId = ontologyAdapter.schemaIds[entityType];
  try {
    assertAllowedOfficialSchemaId(entityType, configuredSchemaId);
  } catch (error) {
    const message = error instanceof W3dsSchemaIdPolicyError ? error.message : String(error);
    throw new W3dsMappingRulesError(message);
  }

  if (typeof source.schemaId === 'string' && source.schemaId.trim()) {
    const fileSchemaId = source.schemaId.trim();
    if (!isDisallowedPlaceholderSchemaId(fileSchemaId) && fileSchemaId !== configuredSchemaId) {
      throw new W3dsMappingRulesError(
        `Official Mapping Rules for "${tableName}" must not bake in schemaId "${fileSchemaId}". Schema IDs come from configuration only.`,
      );
    }
  }

  const document: W3dsMappingRulesDocument = {
    tableName,
    entityType,
    schemaId: configuredSchemaId,
    ownerEnamePath,
    localToUniversalMap: resolvedMap,
  };

  if (typeof source.readOnly === 'boolean') {
    document.readOnly = source.readOnly;
  }
  if (source.ownedJunctionTables !== undefined) {
    if (
      !Array.isArray(source.ownedJunctionTables) ||
      source.ownedJunctionTables.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new W3dsMappingRulesError(
        `Official Mapping Rules ownedJunctionTables on "${tableName}" must be an array of table names.`,
      );
    }
    document.ownedJunctionTables = source.ownedJunctionTables.map((value) => value.trim());
  }

  if (isDisallowedPlaceholderSchemaId(document.schemaId)) {
    throw new W3dsMappingRulesError(
      `Official Mapping Rules for "${tableName}" resolved to a placeholder schemaId.`,
    );
  }

  return document;
}

function isDocumentedMappingDirective(value: string): boolean {
  return (
    DIRECT_FIELD.test(value) ||
    DATE_DIRECTIVE.test(value) ||
    FILE_DIRECTIVE.test(value) ||
    CALC_DIRECTIVE.test(value) ||
    RELATION_DIRECTIVE.test(value)
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new W3dsMappingRulesError(`Official Mapping Rules require a non-empty ${field}.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
