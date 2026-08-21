/**
 * Fixture toGlobal / fromGlobal mapper for official Mapping Rules.
 *
 * Directives are the documented Mapping Rules set only (direct fields, relations,
 * __date, __file, __calc). __file passes through existing W3DS file URIs and
 * plain HTTP(S) URLs. Inline data URIs require an explicit, server-test-injected
 * file client; the production eVault file client remains unavailable. __calc is
 * rejected rather than evaluated. fromGlobal only dereferences when explicitly
 * given that same injected client.
 */

import { entityTypeForAdapterTable, type W3dsAdapterMappingService } from './w3ds-adapter-mapping';
import type { W3dsMappingRulesDocument } from './w3ds-mapping-rules';
import {
  optionalW3dsFileUri,
  type W3dsOfficialFileClient,
  type W3dsOfficialFileUploadInput,
} from './w3ds-official-file-client';

const eNamePattern = /^@[^\s@]+$/;
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

/**
 * P3 stays injection-only until the official eVault client gate opens. The
 * caller supplies every documented upload input; no ACL, filename, or MIME type
 * is guessed from a product URL or media-storage record.
 */
export interface W3dsOfficialMapperFileUploadPolicy {
  client: W3dsOfficialFileClient;
  createInput(input: {
    localField: string;
    value: string;
    ownerEName: string;
  }): W3dsOfficialFileUploadInput;
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
  fileUpload?: W3dsOfficialMapperFileUploadPolicy;
}): Promise<OfficialToGlobalResult> {
  const payload: Record<string, unknown> = {};
  const ownerEName = resolveOwnerENameFromPath(input.data, input.mapping.ownerEnamePath);

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
      const mapped = await mapFileValue({
        value: getFileValueAtPath(input.data, fileMatch[1] ?? localField),
        localField,
        ownerEName,
        fileUpload: input.fileUpload,
      });
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
    ownerEName,
  };
}

export async function fromGlobal(input: {
  data: Record<string, unknown>;
  mapping: W3dsMappingRulesDocument;
  mappingService: W3dsAdapterMappingService;
  fileClient?: W3dsOfficialFileClient;
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
      if (typeof value === 'string') {
        const fileUri = optionalW3dsFileUri(value);
        if (fileUri) {
          local[localField] = input.fileClient
            ? await input.fileClient.dereferenceFileUri(fileUri)
            : fileUri;
        } else if (isPlainHttpUrl(value)) {
          local[localField] = value;
        }
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

async function mapFileValue(input: {
  value: unknown;
  localField: string;
  ownerEName: string | undefined;
  fileUpload: W3dsOfficialMapperFileUploadPolicy | undefined;
}): Promise<string | string[] | undefined> {
  const mapOne = async (value: unknown): Promise<string | undefined> => {
    if (typeof value !== 'string') return undefined;
    const fileUri = optionalW3dsFileUri(value);
    if (fileUri || isPlainHttpUrl(value)) return value.trim();
    if (!isDataUri(value)) return undefined;
    if (!input.ownerEName || !input.fileUpload) {
      throw new W3dsOfficialMapperError(
        `Official mapper cannot upload inline file data for "${input.localField}" while the eVault file client is unavailable.`,
        'file_upload_unavailable',
      );
    }
    const uploadInput = input.fileUpload.createInput({
      localField: input.localField,
      value,
      ownerEName: input.ownerEName,
    });
    if (uploadInput.ownerEName.trim() !== input.ownerEName) {
      throw new W3dsOfficialMapperError(
        `Official mapper file upload for "${input.localField}" changed the resolved owner eName.`,
        'invalid_file_owner',
      );
    }
    return (await input.fileUpload.client.uploadFile(uploadInput)).uri;
  };

  if (Array.isArray(input.value)) {
    const mapped = await Promise.all(input.value.map(mapOne));
    const entries = mapped.filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries : undefined;
  }
  return mapOne(input.value);
}

function isDataUri(value: string): boolean {
  return /^data:[^,]+,/i.test(value.trim());
}

function isPlainHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export { optionalW3dsFileUri };

/**
 * Mapping Rules allow __file(images[].src). Keep this narrow to file directives
 * so normal direct-field and relation traversal retain their existing behavior.
 */
function getFileValueAtPath(data: unknown, path: string): unknown {
  if (!path) return undefined;
  return readFilePath(data, path.split('.'));
}

function readFilePath(value: unknown, segments: readonly string[]): unknown {
  const [segment, ...rest] = segments;
  if (!segment) return value;
  const arraySegment = segment.endsWith('[]');
  const key = arraySegment ? segment.slice(0, -2) : segment;
  if (!isRecord(value)) return undefined;
  const next = value[key];
  if (!arraySegment) return readFilePath(next, rest);
  if (!Array.isArray(next)) return undefined;
  return next
    .map((entry) => readFilePath(entry, rest))
    .filter((entry) => entry !== undefined && entry !== null);
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
