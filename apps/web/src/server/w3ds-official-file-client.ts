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
