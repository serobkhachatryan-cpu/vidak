/// <reference path="./server-only-module.d.ts" />
/**
 * Loopback-only official eVault client for P1C sandbox compatibility tests.
 *
 * Resolves eNames with Registry GET /resolve and calls documented GraphQL
 * createMetaEnvelope / updateMetaEnvelope / removeMetaEnvelope with X-ENAME.
 * Tests may inject an in-memory Registry-issued platform token; GraphQL then
 * also sends Authorization: Bearer. Constructor and every follow-up URL must
 * be 127.0.0.1, localhost, or ::1. Production resolveW3dsOfficialEVaultClient
 * never returns this client. Does not request Registry platform certification
 * and does not call Ontology. Requires W3DS_SANDBOX_COMPAT_ENABLED=true;
 * a sandbox:// source string is not authentication.
 */

import 'server-only';
import {
  W3DS_OFFICIAL_SANDBOX_CLIENT_SOURCES,
  type W3dsOfficialEVaultClient,
  type W3dsOfficialMetaEnvelopeCreateResult,
  type W3dsOfficialMetaEnvelopeRemoveResult,
  type W3dsOfficialMetaEnvelopeUpdateResult,
  type W3dsOfficialMetaEnvelopeWriteInput,
} from './w3ds-official-evault-client';
import { isDocumentedExampleOntologySchemaId } from './w3ds-schema-id-policy';

const requestTimeoutMs = 8_000;
const eNamePattern = /^@[^\s@]+$/;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

const CREATE_META_ENVELOPE = `mutation CreateSandboxMetaEnvelope($input: MetaEnvelopeInput!) {
  createMetaEnvelope(input: $input) {
    metaEnvelope { id ontology parsed }
    errors { field message code }
  }
}`;

const UPDATE_META_ENVELOPE = `mutation UpdateSandboxMetaEnvelope($id: ID!, $input: MetaEnvelopeInput!) {
  updateMetaEnvelope(id: $id, input: $input) {
    metaEnvelope { id ontology parsed }
    errors { message code }
  }
}`;

const REMOVE_META_ENVELOPE = `mutation RemoveSandboxMetaEnvelope($id: ID!) {
  removeMetaEnvelope(id: $id) {
    deletedId
    success
    errors { message code }
  }
}`;

const READ_META_ENVELOPE = `query ReadSandboxMetaEnvelope($id: ID!) {
  metaEnvelope(id: $id) {
    id
    ontology
    parsed
  }
}`;

export class W3dsOfficialSandboxEVaultError extends Error {
  readonly code: string;

  constructor(message: string, code = 'sandbox_evault_failed') {
    super(message);
    this.name = 'W3dsOfficialSandboxEVaultError';
    this.code = code;
  }
}

export interface W3dsOfficialSandboxRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface W3dsOfficialSandboxEVaultClientOptions {
  registryBaseUrl: string;
  fetch?: typeof fetch;
  source?: (typeof W3DS_OFFICIAL_SANDBOX_CLIENT_SOURCES)[number];
  /**
   * In-memory Registry-issued platform token for GraphQL Authorization.
   * Never persist, log, or print this value. Empty/whitespace is treated as absent.
   */
  platformToken?: string;
}

export function isSandboxCompatEnabled(): boolean {
  return process.env.W3DS_SANDBOX_COMPAT_ENABLED === 'true';
}

export function assertSandboxCompatEnabled(): void {
  if (!isSandboxCompatEnabled()) {
    throw new W3dsOfficialSandboxEVaultError(
      'Sandbox eVault client is disabled until W3DS_SANDBOX_COMPAT_ENABLED=true. A sandbox:// source string is not authentication.',
      'compat_disabled',
    );
  }
}

export function isSandboxLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && loopbackHosts.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export function assertSandboxLoopbackHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new W3dsOfficialSandboxEVaultError(
      `${label} must be a loopback HTTP(S) URL.`,
      'non_loopback',
    );
  }
  const host = url.hostname.toLowerCase();
  if (host === 'metastate.foundation' || host.endsWith('.metastate.foundation')) {
    throw new W3dsOfficialSandboxEVaultError(
      `${label} refuses production MetaState hosts.`,
      'production_endpoint',
    );
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !loopbackHosts.has(url.hostname)) {
    throw new W3dsOfficialSandboxEVaultError(
      `${label} must be a loopback HTTP(S) URL.`,
      'non_loopback',
    );
  }
  return url;
}

export function assertSandboxFixtureOntology(schemaId: string): string {
  const normalized = schemaId.trim();
  if (!normalized) {
    throw new W3dsOfficialSandboxEVaultError(
      'Sandbox createMetaEnvelope requires a fixture ontology id.',
      'missing_schema_id',
    );
  }
  if (isDocumentedExampleOntologySchemaId(normalized)) {
    throw new W3dsOfficialSandboxEVaultError(
      `Sandbox createMetaEnvelope refuses documented example ontology IDs ("${normalized}"). Do not substitute User, SocialMediaPost, Group, File, or w3ds-file-v1.`,
      'example_ontology_id',
    );
  }
  return normalized;
}

export class W3dsOfficialSandboxEVaultClient implements W3dsOfficialEVaultClient {
  readonly source: (typeof W3DS_OFFICIAL_SANDBOX_CLIENT_SOURCES)[number];
  readonly requests: W3dsOfficialSandboxRequestRecord[] = [];
  readonly registryBaseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly platformToken: string | undefined;

  constructor(options: W3dsOfficialSandboxEVaultClientOptions) {
    assertSandboxCompatEnabled();
    this.registryBaseUrl = assertSandboxLoopbackHttpUrl(
      options.registryBaseUrl,
      'Sandbox Registry URL',
    );
    this.fetcher = options.fetch ?? fetch;
    this.platformToken = normalizeOptionalToken(options.platformToken);
    this.source = options.source ?? 'sandbox://127.0.0.1';
    if (!(W3DS_OFFICIAL_SANDBOX_CLIENT_SOURCES as readonly string[]).includes(this.source)) {
      throw new W3dsOfficialSandboxEVaultError(
        'Sandbox eVault client source must be sandbox://127.0.0.1 or sandbox://localhost.',
        'invalid_source',
      );
    }
  }

  async resolveEvaultUri(eName: string): Promise<string> {
    const ownerEName = assertEName(eName, 'resolveEvaultUri');
    const url = new URL('/resolve', this.registryBaseUrl);
    url.searchParams.set('w3id', ownerEName);
    const payload = await this.requestJson(url, { method: 'GET' }, 'Registry resolve');
    if (!isRecord(payload) || typeof payload.uri !== 'string') {
      throw new W3dsOfficialSandboxEVaultError(
        'Registry /resolve did not return a uri for the owner eName.',
        'resolve_failed',
      );
    }
    return assertSandboxLoopbackHttpUrl(payload.uri, 'Resolved eVault URI').toString();
  }

  async whois(eName: string): Promise<unknown> {
    const ownerEName = assertEName(eName, 'whois');
    const evaultUri = await this.resolveEvaultUri(ownerEName);
    return this.requestJson(
      new URL('/whois', evaultUri),
      {
        method: 'GET',
        headers: { 'X-ENAME': ownerEName },
      },
      'eVault /whois',
    );
  }

  async createMetaEnvelope(
    input: W3dsOfficialMetaEnvelopeWriteInput,
  ): Promise<W3dsOfficialMetaEnvelopeCreateResult> {
    const ownerEName = assertEName(input.ownerEName, 'createMetaEnvelope');
    const ontology = assertSandboxFixtureOntology(input.schemaId);
    const result = await this.graphql(ownerEName, CREATE_META_ENVELOPE, {
      input: {
        ontology,
        payload: input.payload,
        acl: ['*'],
      },
    });
    const created = fieldRecord(result, 'createMetaEnvelope');
    assertMutationErrors(created, 'createMetaEnvelope');
    const metaEnvelope = fieldRecord(created, 'metaEnvelope');
    const id = requiredString(metaEnvelope.id, 'createMetaEnvelope id');
    return { id };
  }

  async updateMetaEnvelope(
    input: W3dsOfficialMetaEnvelopeWriteInput & { id: string },
  ): Promise<W3dsOfficialMetaEnvelopeUpdateResult> {
    const ownerEName = assertEName(input.ownerEName, 'updateMetaEnvelope');
    const ontology = assertSandboxFixtureOntology(input.schemaId);
    const result = await this.graphql(ownerEName, UPDATE_META_ENVELOPE, {
      id: input.id,
      input: {
        ontology,
        payload: input.payload,
        acl: ['*'],
      },
    });
    const updated = fieldRecord(result, 'updateMetaEnvelope');
    assertMutationErrors(updated, 'updateMetaEnvelope');
    const metaEnvelope = fieldRecord(updated, 'metaEnvelope');
    const id = requiredString(metaEnvelope.id, 'updateMetaEnvelope id');
    return { id };
  }

  async removeMetaEnvelope(input: {
    ownerEName: string;
    id: string;
  }): Promise<W3dsOfficialMetaEnvelopeRemoveResult> {
    const ownerEName = assertEName(input.ownerEName, 'removeMetaEnvelope');
    const result = await this.graphql(ownerEName, REMOVE_META_ENVELOPE, { id: input.id });
    const removed = fieldRecord(result, 'removeMetaEnvelope');
    assertMutationErrors(removed, 'removeMetaEnvelope');
    return {
      deletedId: typeof removed.deletedId === 'string' ? removed.deletedId : input.id,
      success: removed.success === true,
    };
  }

  async readMetaEnvelope(input: {
    ownerEName: string;
    id: string;
  }): Promise<Record<string, unknown>> {
    const ownerEName = assertEName(input.ownerEName, 'metaEnvelope');
    const result = await this.graphql(ownerEName, READ_META_ENVELOPE, { id: input.id });
    return fieldRecord(result, 'metaEnvelope');
  }

  graphqlRequests(): W3dsOfficialSandboxRequestRecord[] {
    return this.requests.filter((request) => request.url.includes('/graphql'));
  }

  private async graphql(
    ownerEName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const evaultUri = await this.resolveEvaultUri(ownerEName);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-ENAME': ownerEName,
    };
    if (this.platformToken) {
      headers.Authorization = `Bearer ${this.platformToken}`;
    }
    const payload = await this.requestJson(
      new URL('/graphql', evaultUri),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      },
      'eVault /graphql',
    );
    if (!isRecord(payload)) {
      throw new W3dsOfficialSandboxEVaultError(
        'eVault GraphQL returned a non-object body.',
        'graphql_failed',
      );
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new W3dsOfficialSandboxEVaultError(
        'eVault GraphQL returned errors for the documented mutation.',
        'graphql_errors',
      );
    }
    if (!isRecord(payload.data)) {
      throw new W3dsOfficialSandboxEVaultError(
        'eVault GraphQL returned no data.',
        'graphql_failed',
      );
    }
    return payload.data;
  }

  private async requestJson(url: URL, init: RequestInit, label: string): Promise<unknown> {
    assertSandboxCompatEnabled();
    assertSandboxLoopbackHttpUrl(url.toString(), label);
    const headers = normalizeHeaders(init.headers);
    this.requests.push({
      method: (init.method ?? 'GET').toUpperCase(),
      url: url.toString(),
      headers: redactAuthorizationHeader(headers),
    });
    let response: Response;
    try {
      response = await this.fetcher(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(requestTimeoutMs),
        ...init,
        headers,
      });
    } catch {
      throw new W3dsOfficialSandboxEVaultError(`${label} is unavailable.`, 'unavailable');
    }
    if (response.status === 404) {
      throw new W3dsOfficialSandboxEVaultError(`${label} returned 404.`, 'not_found');
    }
    if (!response.ok) {
      throw new W3dsOfficialSandboxEVaultError(`${label} rejected the request.`, 'rejected');
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new W3dsOfficialSandboxEVaultError(`${label} returned invalid JSON.`, 'invalid_json');
    }
  }
}

function assertEName(eName: string, method: string): string {
  const trimmed = eName.trim();
  if (!eNamePattern.test(trimmed)) {
    throw new W3dsOfficialSandboxEVaultError(
      `${method} requires a valid owner eName (e.g. @user.w3id).`,
    );
  }
  return trimmed;
}

function assertMutationErrors(payload: Record<string, unknown>, field: string): void {
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new W3dsOfficialSandboxEVaultError(
      `eVault ${field} returned errors[]. The local fixture ontology was not accepted.`,
      'fixture_ontology_rejected',
    );
  }
}

function fieldRecord(payload: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = payload[field];
  if (!isRecord(value)) {
    throw new W3dsOfficialSandboxEVaultError(
      `eVault GraphQL ${field} payload was missing.`,
      'graphql_failed',
    );
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new W3dsOfficialSandboxEVaultError(`${label} was missing.`, 'graphql_failed');
  }
  return value.trim();
}

function normalizeOptionalToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function redactAuthorizationHeader(headers: Record<string, string>): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    recorded[key] =
      key.toLowerCase() === 'authorization'
        ? value.toLowerCase().startsWith('bearer ')
          ? 'Bearer <redacted>'
          : '<redacted>'
        : value;
  }
  return recorded;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) result[key] = value;
    return result;
  }
  return { ...headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
