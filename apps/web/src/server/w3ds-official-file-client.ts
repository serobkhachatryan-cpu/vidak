/**
 * Server-only File URI boundary for the documented eVault uploadFile contract.
 *
 * Production resolution remains unavailable with the P1A eVault gate closed.
 * The in-memory implementation exists solely for explicit server-test injection;
 * it never performs HTTP, stores a local media asset, or enables production writes.
 */

import 'server-only';

import { W3dsOfficialAdapterGateError } from './w3ds-official-adapter-gate';

const eNamePattern = /^@[^/\s@]+$/;
const fileUriPattern = /^w3ds:\/\/file\?id=(@[^/\s]+)\/([^\s]+)$/;
const dataUriPattern = /^data:([^;,\s]+);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The checked-in File URIs contract limits decoded upload content to 50 MB. */
export const W3DS_FILE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export class W3dsOfficialFileClientError extends Error {
  readonly code: string;

  constructor(message: string, code = 'official_file_client_failed') {
    super(message);
    this.name = 'W3dsOfficialFileClientError';
    this.code = code;
  }
}

export interface W3dsOfficialFileUploadInput {
  ownerEName: string;
  filename: string;
  contentType: string;
  /** Raw base64 or a data URI, exactly as the documented mutation accepts. */
  content: string;
  acl: readonly string[];
}

export interface W3dsOfficialFileUploadResult {
  uri: string;
  metaEnvelopeId: string;
  publicUrl: string;
}

export interface W3dsOfficialFileClient {
  readonly source: string;
  uploadFile(input: W3dsOfficialFileUploadInput): Promise<W3dsOfficialFileUploadResult>;
  dereferenceFileUri(uri: string): Promise<string>;
}

/**
 * Narrow, server-side HTTP abstraction for the documented Registry/eVault
 * File URI flow. A caller must supply it explicitly; P1A does not wire a
 * runtime transport or select this client for production use.
 */
export interface W3dsOfficialFileHttpTransport {
  request(
    url: string,
    init: {
      method: 'GET' | 'POST';
      headers: Readonly<Record<string, string>>;
      body?: string;
      redirect?: 'manual';
    },
  ): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
}

export interface W3dsOfficialFileHttpClientOptions {
  /** Registry base URL used only by an explicitly injected server transport. */
  registryBaseUrl: string;
  transport: W3dsOfficialFileHttpTransport;
}

export type W3dsOfficialFileClientResolution = {
  status: 'unavailable';
  missing: readonly string[];
};

/**
 * Deliberately fail closed: a real GraphQL eVault client and its authorization
 * must not be constructed until the existing production eVault gate opens.
 */
export function resolveW3dsOfficialFileClient(): W3dsOfficialFileClientResolution {
  return {
    status: 'unavailable',
    missing: [
      'The production W3DS eVault File client is unavailable while official eVault writes remain gated.',
    ],
  };
}

export function requireW3dsOfficialFileClient(): W3dsOfficialFileClient {
  const resolved = resolveW3dsOfficialFileClient();
  throw new W3dsOfficialAdapterGateError(
    `W3DS official file client is unavailable: ${resolved.missing.join(' ')}`,
    'http_evault_client_unavailable',
  );
}

export interface W3dsFileUri {
  ownerEName: string;
  metaEnvelopeId: string;
}

export function parseW3dsFileUri(value: string | undefined | null): W3dsFileUri | undefined {
  const match = fileUriPattern.exec(value?.trim() ?? '');
  if (!match) return undefined;
  const ownerEName = match[1] ?? '';
  const metaEnvelopeId = match[2] ?? '';
  if (!eNamePattern.test(ownerEName) || !metaEnvelopeId) return undefined;
  return { ownerEName, metaEnvelopeId };
}

export function optionalW3dsFileUri(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return parseW3dsFileUri(trimmed) ? trimmed : undefined;
}

function assertUploadInput(input: W3dsOfficialFileUploadInput): void {
  if (!eNamePattern.test(input.ownerEName.trim())) {
    throw new W3dsOfficialFileClientError(
      'uploadFile requires a valid owner eName.',
      'invalid_owner_ename',
    );
  }
  if (!input.filename.trim()) {
    throw new W3dsOfficialFileClientError('uploadFile requires a filename.', 'invalid_filename');
  }
  if (!input.contentType.trim()) {
    throw new W3dsOfficialFileClientError(
      'uploadFile requires a contentType.',
      'invalid_content_type',
    );
  }
  if (!input.acl.length || input.acl.some((entry) => !entry.trim())) {
    throw new W3dsOfficialFileClientError('uploadFile requires a non-empty ACL.', 'invalid_acl');
  }
  decodeBase64Content(input.content);
}

function decodeBase64Content(content: string): Buffer {
  const match = dataUriPattern.exec(content.trim());
  const base64 = match ? match[2] : content.trim();
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new W3dsOfficialFileClientError(
      'uploadFile content must be valid base64.',
      'invalid_content',
    );
  }
  const decoded = Buffer.from(base64, 'base64');
  if (!decoded.length || decoded.toString('base64') !== base64) {
    throw new W3dsOfficialFileClientError(
      'uploadFile content must be valid base64.',
      'invalid_content',
    );
  }
  if (decoded.length > W3DS_FILE_UPLOAD_MAX_BYTES) {
    throw new W3dsOfficialFileClientError(
      'uploadFile content exceeds the documented 50 MB decoded limit.',
      'file_too_large',
    );
  }
  return decoded;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function absoluteHttpUrl(value: string, code: string): string {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('unsupported URL');
    }
    return parsed.toString();
  } catch {
    throw new W3dsOfficialFileClientError('W3DS File endpoint is unavailable.', code);
  }
}

function graphQlUrl(evaultUrl: string): string {
  return new URL('/graphql', evaultUrl).toString();
}

function fileUrl(evaultUrl: string, metaEnvelopeId: string): string {
  return new URL(`/files/${encodeURIComponent(metaEnvelopeId)}`, evaultUrl).toString();
}

function parseUploadResult(value: unknown, ownerEName: string): W3dsOfficialFileUploadResult {
  const root = asRecord(value);
  const data = asRecord(root?.data);
  const upload = asRecord(data?.uploadFile);
  const errors = Array.isArray(upload?.errors) ? upload.errors : [];
  if (errors.length) {
    throw new W3dsOfficialFileClientError('eVault uploadFile failed.', 'file_upload_failed');
  }

  const uri = typeof upload?.uri === 'string' ? upload.uri.trim() : '';
  const metaEnvelopeId =
    typeof upload?.metaEnvelopeId === 'string' ? upload.metaEnvelopeId.trim() : '';
  const publicUrl = typeof upload?.publicUrl === 'string' ? upload.publicUrl.trim() : '';
  const parsedUri = parseW3dsFileUri(uri);
  if (
    !parsedUri ||
    parsedUri.ownerEName !== ownerEName ||
    parsedUri.metaEnvelopeId !== metaEnvelopeId ||
    !publicUrl
  ) {
    throw new W3dsOfficialFileClientError(
      'eVault uploadFile returned an invalid File URI payload.',
      'file_upload_failed',
    );
  }
  return { uri, metaEnvelopeId, publicUrl: absoluteHttpUrl(publicUrl, 'file_upload_failed') };
}

/**
 * Protocol-exact File URI client for server-side, explicit transport injection.
 *
 * It models only the checked-in File URI contract: Registry resolution, an
 * eVault uploadFile GraphQL mutation, and a manual eVault /files redirect.
 * `resolveW3dsOfficialFileClient()` deliberately never constructs this class;
 * that P1A gate must open independently before production use is considered.
 */
export class W3dsOfficialFileHttpClient implements W3dsOfficialFileClient {
  readonly source = 'injected://w3ds-official-file-http-client';
  private readonly registryBaseUrl: string;

  constructor(private readonly options: W3dsOfficialFileHttpClientOptions) {
    this.registryBaseUrl = absoluteHttpUrl(options.registryBaseUrl, 'registry_url_invalid');
  }

  async uploadFile(input: W3dsOfficialFileUploadInput): Promise<W3dsOfficialFileUploadResult> {
    assertUploadInput(input);
    const ownerEName = input.ownerEName.trim();
    const evaultUrl = await this.resolveEVaultUrl(ownerEName);
    const response = await this.request(
      graphQlUrl(evaultUrl),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ENAME': ownerEName,
        },
        body: JSON.stringify({
          query:
            'mutation UploadFile($input: UploadFileInput!) { uploadFile(input: $input) { uri metaEnvelopeId publicUrl errors { field message code } } }',
          variables: {
            input: {
              filename: input.filename.trim(),
              contentType: input.contentType.trim(),
              content: input.content.trim(),
              acl: input.acl.map((entry) => entry.trim()),
            },
          },
        }),
      },
      'file_upload_failed',
    );
    return parseUploadResult(response, ownerEName);
  }

  async dereferenceFileUri(uri: string): Promise<string> {
    const parsed = parseW3dsFileUri(uri);
    if (!parsed) {
      throw new W3dsOfficialFileClientError(
        'dereferenceFileUri requires a valid W3DS File URI.',
        'invalid_file_uri',
      );
    }

    const evaultUrl = await this.resolveEVaultUrl(parsed.ownerEName);
    let response: Awaited<ReturnType<W3dsOfficialFileHttpTransport['request']>>;
    try {
      response = await this.options.transport.request(fileUrl(evaultUrl, parsed.metaEnvelopeId), {
        method: 'GET',
        headers: { 'X-ENAME': parsed.ownerEName },
        redirect: 'manual',
      });
    } catch {
      throw new W3dsOfficialFileClientError(
        'eVault File dereference failed.',
        'file_dereference_failed',
      );
    }
    if (response.status !== 302) {
      throw new W3dsOfficialFileClientError(
        'eVault File dereference failed.',
        'file_dereference_failed',
      );
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new W3dsOfficialFileClientError(
        'eVault File dereference returned no redirect.',
        'file_dereference_failed',
      );
    }
    return absoluteHttpUrl(location, 'file_dereference_failed');
  }

  private async resolveEVaultUrl(ownerEName: string): Promise<string> {
    const resolveUrl = new URL('/resolve', this.registryBaseUrl);
    resolveUrl.searchParams.set('w3id', ownerEName);
    const payload = await this.request(
      resolveUrl.toString(),
      { method: 'GET', headers: {} },
      'registry_resolution_failed',
    );
    const record = asRecord(payload);
    const eName = typeof record?.ename === 'string' ? record.ename.trim() : '';
    const uri = typeof record?.uri === 'string' ? record.uri.trim() : '';
    if (eName !== ownerEName) {
      throw new W3dsOfficialFileClientError(
        'Registry returned an unexpected eName.',
        'registry_resolution_failed',
      );
    }
    return absoluteHttpUrl(uri, 'registry_resolution_failed');
  }

  private async request(
    url: string,
    init: Parameters<W3dsOfficialFileHttpTransport['request']>[1],
    code: string,
  ): Promise<unknown> {
    let response: Awaited<ReturnType<W3dsOfficialFileHttpTransport['request']>>;
    try {
      response = await this.options.transport.request(url, init);
    } catch {
      throw new W3dsOfficialFileClientError('W3DS File request failed.', code);
    }
    if (!response.ok) {
      throw new W3dsOfficialFileClientError('W3DS File request failed.', code);
    }
    try {
      return await response.json();
    } catch {
      throw new W3dsOfficialFileClientError('W3DS File request failed.', code);
    }
  }
}

/** Explicit test fake. It is never selected by production resolution. */
export class FakeW3dsOfficialFileClient implements W3dsOfficialFileClient {
  readonly source = 'fake://w3ds-official-file-client';
  readonly calls: Array<{ method: 'uploadFile' | 'dereferenceFileUri'; input: unknown }> = [];
  private readonly publicUrls = new Map<string, string>();
  private sequence = 0;

  async uploadFile(input: W3dsOfficialFileUploadInput): Promise<W3dsOfficialFileUploadResult> {
    assertUploadInput(input);
    const ownerEName = input.ownerEName.trim();
    const metaEnvelopeId = `file_fake_${++this.sequence}`;
    const uri = `w3ds://file?id=${ownerEName}/${metaEnvelopeId}`;
    const publicUrl = `https://files.invalid/${metaEnvelopeId}/${encodeURIComponent(input.filename.trim())}`;
    this.calls.push({ method: 'uploadFile', input: { ...input, ownerEName } });
    this.publicUrls.set(uri, publicUrl);
    return { uri, metaEnvelopeId, publicUrl };
  }

  async dereferenceFileUri(uri: string): Promise<string> {
    if (!parseW3dsFileUri(uri)) {
      throw new W3dsOfficialFileClientError(
        'dereferenceFileUri requires a valid W3DS File URI.',
        'invalid_file_uri',
      );
    }
    this.calls.push({ method: 'dereferenceFileUri', input: uri });
    const publicUrl = this.publicUrls.get(uri);
    if (!publicUrl) {
      throw new W3dsOfficialFileClientError(
        'Fake file client has no matching File Meta Envelope.',
        'file_not_found',
      );
    }
    return publicUrl;
  }
}
