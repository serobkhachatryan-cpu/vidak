/**
 * Fixture toGlobal / fromGlobal mapper for official Mapping Rules.
 *
 * Directives are the documented Mapping Rules set only (direct fields, relations,
 * __date, __file, __calc). __file is pass-through for existing w3ds://file URIs
 * and otherwise omitted — no uploadFile (P3). __calc is rejected rather than
 * evaluated. fromGlobal does not dereference files over the network.
 */

import { entityTypeForAdapterTable, type W3dsAdapterMappingService } from './w3ds-adapter-mapping';
import type { W3dsMappingRulesDocument } from './w3ds-mapping-rules';

const eNamePattern = /^@[^\s@]+$/;
const w3dsFileUriPattern = /^w3ds:\/\/file\?id=@[^/\s]+\/[^\s]+$/;
const DATE_DIRECTIVE = /^__date\((.+)\)$/;
const FILE_DIRECTIVE = /^__file\((.+)\)(?:,([A-Za-z_][A-Za-z0-9_]*))?$/;
const RELATION_DIRECTIVE = /^([A-Za-z_][A-Za-z0-9_]*)\((.+)\),([A-Za-z_][A-Za-z0-9_]*)$/;
const DIRECT_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CALC_DIRECTIVE = /^__calc\(.+\)$/;
const OWNER_RELATION = /^([A-Za-z_][A-Za-z0-9_]*)\((.+)\)$/;

export class W3dsOfficialMapperError extends Error {
  readonly code: string;

  constructor(message: string, code = 'official_mapper_failed') {
    super(message);
    this.name = 'W3dsOfficialMapperError';
    this.code = code;
  }
}

export interface OfficialToGlobalResult {
  payload: Record<string, unknown>;
  ownerEName: string | undefined;
}

export function resolveOwnerENameFromPath(
  data: Record<string, unknown>,
  ownerEnamePath: string,
): string | undefined {
  const candidates = ownerEnamePath.split('||').map((part) => part.trim());
  for (const candidate of candidates) {
    const relation = OWNER_RELATION.exec(candidate);
    const value = relation ? getAtPath(data, relation[2] ?? '') : getAtPath(data, candidate);
    const eName = asEName(value);
    if (eName) return eName;
  }
  return asEName(data.ownerEName);
}

export async function toGlobal(input: {
  data: Record<string, unknown>;
  mapping: W3dsMappingRulesDocument;
  mappingService: W3dsAdapterMappingService;
}): Promise<OfficialToGlobalResult> {
  const payload: Record<string, unknown> = {};

  for (const [localField, directive] of Object.entries(input.mapping.localToUniversalMap)) {
    if (CALC_DIRECTIVE.test(directive)) {
      throw new W3dsOfficialMapperError(
        `Official mapper does not evaluate __calc on "${localField}".`,
        'unsupported_directive',
      );
    }

    const dateMatch = DATE_DIRECTIVE.exec(directive);
    if (dateMatch) {
      const converted = toIsoDate(getAtPath(input.data, dateMatch[1] ?? localField));
      if (converted !== undefined) {
        payload[localField] = converted;
      }
      continue;
    }

    const fileMatch = FILE_DIRECTIVE.exec(directive);
    if (fileMatch) {
      const alias = fileMatch[2] ?? fileMatch[1] ?? localField;
      const mapped = mapFileValue(getAtPath(input.data, fileMatch[1] ?? localField));
      if (mapped !== undefined) {
        payload[alias] = mapped;
      }
      continue;
    }

    const relationMatch = RELATION_DIRECTIVE.exec(directive);
    if (relationMatch) {
      const tableName = relationMatch[1] ?? '';
      const path = relationMatch[2] ?? '';
      const alias = relationMatch[3] ?? localField;
      const mapped = await mapRelationValue({
        tableName,
        path,
        data: input.data,
        mappingService: input.mappingService,
        optional: localField === 'parentId',
      });
      if (mapped !== undefined) {
        payload[alias] = mapped;
      }
      continue;
    }

    if (!DIRECT_FIELD.test(directive)) {
      throw new W3dsOfficialMapperError(
        `Official mapper rejected undocumented directive "${directive}" on "${localField}".`,
        'undocumented_directive',
      );
    }

    const value = getAtPath(input.data, localField);
    if (value !== undefined && value !== null && value !== '') {
      payload[directive] = value;
    }
  }

  return {
    payload,
    ownerEName: resolveOwnerENameFromPath(input.data, input.mapping.ownerEnamePath),
  };
}

export async function fromGlobal(input: {
  data: Record<string, unknown>;
  mapping: W3dsMappingRulesDocument;
  mappingService: W3dsAdapterMappingService;
}): Promise<Record<string, unknown>> {
  const local: Record<string, unknown> = {};

  for (const [localField, directive] of Object.entries(input.mapping.localToUniversalMap)) {
    const dateMatch = DATE_DIRECTIVE.exec(directive);
    if (dateMatch) {
      const value = input.data[localField];
      if (value !== undefined) local[localField] = value;
      continue;
    }

    const fileMatch = FILE_DIRECTIVE.exec(directive);
    if (fileMatch) {
      const alias = fileMatch[2] ?? fileMatch[1] ?? localField;
      const value = input.data[alias];
      if (typeof value === 'string' && w3dsFileUriPattern.test(value)) {
        local[localField] = value;
      }
      continue;
    }

    const relationMatch = RELATION_DIRECTIVE.exec(directive);
    if (relationMatch) {
      const path = relationMatch[2] ?? '';
      const alias = relationMatch[3] ?? localField;
      const globalValue = input.data[alias];
      if (typeof globalValue !== 'string' || !globalValue.trim()) continue;
      if (eNamePattern.test(globalValue.trim()) || /\.eName$/i.test(path)) {
        local[localField] = globalValue.trim();
        continue;
      }
      const mapped = await input.mappingService.getByGlobalId(globalValue.trim());
      if (mapped) {
        local[localField] = mapped.localId;
      }
      continue;
    }

    if (DIRECT_FIELD.test(directive)) {
      const value = input.data[directive];
      if (value !== undefined) local[localField] = value;
    }
  }

  return local;
}

async function mapRelationValue(input: {
  tableName: string;
  path: string;
  data: Record<string, unknown>;
  mappingService: W3dsAdapterMappingService;
  optional: boolean;
}): Promise<string | undefined> {
  const entityType = entityTypeForAdapterTable(input.tableName);
  if (!entityType) {
    throw new W3dsOfficialMapperError(
      `Official mapper relation table "${input.tableName}" is not a configured adapter table.`,
      'unknown_relation_table',
    );
  }

  const extracted = getAtPath(input.data, input.path);
  if (extracted === undefined || extracted === null || extracted === '') {
    if (input.optional) return undefined;
    throw new W3dsOfficialMapperError(
      `Official mapper could not resolve ${input.tableName}(${input.path}).`,
      'missing_relation',
    );
  }
  if (typeof extracted !== 'string') {
    throw new W3dsOfficialMapperError(
      `Official mapper relation ${input.tableName}(${input.path}) must resolve to a local id or eName.`,
      'invalid_relation',
    );
  }

  const trimmed = extracted.trim();
  // ownerEName-style relations copy the eName through; they are not MetaEnvelope IDs.
  if (eNamePattern.test(trimmed) || /\.eName$/i.test(input.path)) {
    const eName = asEName(trimmed);
    if (!eName) {
      throw new W3dsOfficialMapperError(
        `Official mapper relation ${input.tableName}(${input.path}) is not a valid eName.`,
        'invalid_owner_ename',
      );
    }
    return eName;
  }

  const mapped = await input.mappingService.getByLocalId(entityType, trimmed);
  if (!mapped) {
    throw new W3dsOfficialMapperError(
      `Official handleChange cannot use local ${entityType} id ${trimmed} as a MetaEnvelope id.`,
      'unmapped_relation',
    );
  }
  return mapped.globalId;
}

function mapFileValue(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) {
    const mapped = value
      .map((entry) => (typeof entry === 'string' ? optionalW3dsFileUri(entry) : undefined))
      .filter((entry): entry is string => Boolean(entry));
    return mapped.length > 0 ? mapped : undefined;
  }
  return typeof value === 'string' ? optionalW3dsFileUri(value) : undefined;
}

export function optionalW3dsFileUri(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!w3dsFileUriPattern.test(trimmed)) return undefined;
  return trimmed;
}

function toIsoDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value;
    const parsed = new Date(millis);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return undefined;
  }
  if (isRecord(value)) {
    const seconds =
      typeof value._seconds === 'number'
        ? value._seconds
        : typeof value.seconds === 'number'
          ? value.seconds
          : undefined;
    if (seconds !== undefined) {
      const parsed = new Date(seconds * 1000);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
  }
  return undefined;
}

function getAtPath(data: unknown, path: string): unknown {
  if (!path) return undefined;
  const segments = path.split('.');
  let current: unknown = data;
  for (const segment of segments) {
    if (typeof current === 'string' && (segment === 'id' || segment === 'eName')) {
      return current;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function asEName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return eNamePattern.test(trimmed) ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
