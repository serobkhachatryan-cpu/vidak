import { createHmac, timingSafeEqual } from 'node:crypto';
import 'server-only';

import type { AuthUser } from '@w3ds/auth';
import { parseW3dsFileUri } from './w3ds-official-file-client';

const callSessionOntology = 'e815ba40-ef85-4a2b-b6cf-e05a86d4afbd';
const groupManifestOntology = 'a8bfb7cf-3200-4b25-9ea9-ee41100f212e';
const chatOntology = '550e8400-e29b-41d4-a716-446655440003';
const messageOntology = '550e8400-e29b-41d4-a716-446655440004';
const fileOntology = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const pageSize = 100;
const maxPages = 30;
const retryBudgetMs = 8_000;
const requestTimeoutMs = 12_000;
// Call recordings are stored as ~45-second files. A multi-hour recording must
// remain playable through its final segment, while the authenticated stream
// route still verifies the current user on every request.
const streamLifetimeMs = 4 * 60 * 60 * 1000;
const maxCachedMediaUrls = 256;

export type MeshengerVideoKind = 'call-recording' | 'video-message' | 'file';

export interface MeshengerVideo {
  id: string;
  kind: MeshengerVideoKind;
  title: string;
  durationSeconds?: number;
  shape?: string;
  createdAt?: string;
  /** Ordered, opaque, signed, account-bound references. Never CDN URLs. */
  streamIds: string[];
}

export class MeshengerVideoLibraryError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_configured'
      | 'authentication_required'
      | 'remote_unavailable'
      | 'remote_rejected'
      | 'rate_limited'
      | 'invalid_stream'
      | 'stream_expired'
      | 'unsafe_media_url',
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MeshengerVideoLibraryError';
  }
}

type RecordValue = Record<string, unknown>;
interface Envelope {
  id: string;
  ontology: string;
  parsed: RecordValue;
}
interface StreamGrant {
  eName: string;
  fileUri: string;
  expiresAt: number;
}
interface Config {
  registryBaseUrl: string;
  platformName: string;
  signingSecret: string;
}
interface CachedMediaUrl {
  url: string;
  expiresAt: number;
}
interface DiscoveredVideo {
  key: string;
  fileUris: string[];
  kind: MeshengerVideoKind;
  title: string;
  durationSeconds?: number | undefined;
  shape?: string | undefined;
  createdAt?: string | undefined;
}
interface ChatReference {
  groupEName: string;
  chatId: string;
}

const listQuery = `query MeshengerVideos($ontologyId: ID!, $first: Int!, $after: String) {
  metaEnvelopes(filter: { ontologyId: $ontologyId }, first: $first, after: $after) {
    edges { node { id ontology parsed } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const readQuery = `query MeshengerVideoEnvelope($id: ID!) { metaEnvelope(id: $id) { id ontology parsed } }`;
const cachedMediaUrls = new Map<string, CachedMediaUrl>();

/**
 * Read-only Meshenger source. It indexes envelope references and metadata only;
 * public CDN URLs are resolved only inside `resolveMediaUrl` for the stream route.
 */
export class MeshengerVideoLibrary {
  private platformToken: Promise<string> | undefined;

  constructor(private readonly config: Config) {}

  async list(user: Pick<AuthUser, 'eName' | 'eVaultUri'>): Promise<MeshengerVideo[]> {
    const eName = requireEName(user.eName);
    const eVaultUri = user.eVaultUri ? httpUrl(user.eVaultUri) : await this.resolveEVault(eName);
    // eVaults throttle bursts. Scan each source in order so a first historical
    // import does not turn three independent reads into a simultaneous spike.
    const calls = await this.listEnvelopes(eName, eVaultUri, callSessionOntology);
    const chatReferences = await this.listChatReferences(eName, eVaultUri);
    const messages = await this.listEnvelopes(eName, eVaultUri, messageOntology);
    const files = await this.listEnvelopes(eName, eVaultUri, fileOntology);
    const referenced = new Set<string>();
    const found = await this.discoverCallVideos({
      viewerEName: eName,
      sourceEName: eName,
      sourceEVaultUri: eVaultUri,
      calls,
      referenced,
    });
    found.push(...this.discoverMessageVideos(messages, referenced));
    found.push(...this.discoverFileVideos(eName, files, referenced));
    found.push(...(await this.discoverGroupVideos(eName, chatReferences, referenced)));

    const unique = new Map<string, MeshengerVideo>();
    for (const item of found) {
      if (unique.has(item.key)) continue;
      unique.set(item.key, {
        id: item.key,
        kind: item.kind,
        title: item.title,
        ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
        ...(item.shape ? { shape: item.shape } : {}),
        ...(item.createdAt ? { createdAt: item.createdAt } : {}),
        streamIds: item.fileUris.map((fileUri) =>
          createMeshengerVideoStreamId(
            { eName, fileUri, expiresAt: Date.now() + streamLifetimeMs },
            this.config.signingSecret,
          ),
        ),
      });
    }
    return [...unique.values()].sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    );
  }

  async resolveMediaUrl(user: Pick<AuthUser, 'eName'>, streamId: string): Promise<string> {
    const grant = verifyMeshengerVideoStreamId(streamId, this.config.signingSecret);
    if (grant.eName !== requireEName(user.eName)) {
      throw new MeshengerVideoLibraryError(
        'This video is not available to this account.',
        'invalid_stream',
        403,
      );
    }
    const cacheKey = `${grant.eName}\u0000${grant.fileUri}`;
    const cached = cachedMediaUrls.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    if (cached) cachedMediaUrls.delete(cacheKey);
    const file = parseW3dsFileUri(grant.fileUri);
    if (!file) invalidStream();
    const eVaultUri = await this.resolveEVault(file.ownerEName);
    const envelope = await this.readEnvelope(file.ownerEName, eVaultUri, file.metaEnvelopeId);
    const url = optionalString(envelope.parsed.publicUrl) ?? optionalString(envelope.parsed.url);
    if (!url)
      throw new MeshengerVideoLibraryError(
        'The video file is unavailable.',
        'remote_rejected',
        404,
      );
    const mediaUrl = safeMediaUrl(url);
    cacheMediaUrl(cacheKey, mediaUrl, grant.expiresAt);
    return mediaUrl;
  }

  private async resolveCall(
    sourceEName: string,
    sourceEVaultUri: string,
    source: Envelope,
  ): Promise<Envelope | undefined> {
    if (source.parsed.isReference !== true) return source;
    const owner = optionalString(source.parsed.canonicalOwnerEName);
    const id = optionalString(source.parsed.canonicalEnvelopeId);
    if (!owner || !id || !isEName(owner)) return undefined;
    const eVaultUri = owner === sourceEName ? sourceEVaultUri : await this.resolveEVault(owner);
    return this.readEnvelope(owner, eVaultUri, id);
  }

  /**
   * Group calls are only one of the ways Meshenger shares video. The same
   * trusted chat-reference chain also grants access to that group's video
   * messages, circles, and ordinary video File envelopes. Read each group
   * once so multiple references cannot multiply eVault traffic or cards.
   */
  private async discoverGroupVideos(
    viewerEName: string,
    chatReferences: ChatReference[],
    referenced: Set<string>,
  ): Promise<DiscoveredVideo[]> {
    const chatsByGroup = new Map<string, Set<string>>();
    for (const reference of chatReferences) {
      const chatIds = chatsByGroup.get(reference.groupEName) ?? new Set<string>();
      chatIds.add(reference.chatId);
      chatsByGroup.set(reference.groupEName, chatIds);
    }

    const discovered: DiscoveredVideo[] = [];
    for (const [groupEName, chatIds] of chatsByGroup) {
      try {
        const groupEVaultUri = await this.resolveEVault(groupEName);
        const manifests = await this.listEnvelopes(
          groupEName,
          groupEVaultUri,
          groupManifestOntology,
        );
        if (!manifests.some((manifest) => isCurrentGroupMember(manifest.parsed, viewerEName))) {
          continue;
        }
        const calls = await this.listEnvelopes(groupEName, groupEVaultUri, callSessionOntology);
        discovered.push(
          ...(await this.discoverCallVideos({
            viewerEName,
            sourceEName: groupEName,
            sourceEVaultUri: groupEVaultUri,
            calls,
            chatIds,
            referenced,
          })),
        );
        const messages = await this.listEnvelopes(groupEName, groupEVaultUri, messageOntology);
        discovered.push(
          ...this.discoverMessageVideos(
            messages.filter((message) => chatIds.has(optionalString(message.parsed.chatId) ?? '')),
            referenced,
          ),
        );
        const files = await this.listEnvelopes(groupEName, groupEVaultUri, fileOntology);
        discovered.push(...this.discoverFileVideos(groupEName, files, referenced));
      } catch {
        // A stale chat reference or a group that no longer grants access must
        // not hide the rest of a person's Meshenger library.
      }
    }
    return discovered;
  }

  private async discoverCallVideos({
    viewerEName,
    sourceEName,
    sourceEVaultUri,
    calls,
    chatId,
    chatIds,
    referenced,
  }: {
    viewerEName: string;
    sourceEName: string;
    sourceEVaultUri: string;
    calls: Envelope[];
    chatId?: string;
    chatIds?: ReadonlySet<string>;
    referenced: Set<string>;
  }): Promise<DiscoveredVideo[]> {
    const discovered: DiscoveredVideo[] = [];
    for (const source of calls) {
      const call = await this.resolveCall(sourceEName, sourceEVaultUri, source);
      if (!call || !participated(call.parsed, viewerEName)) continue;
      const callChatId = optionalString(call.parsed.chatId);
      if (chatId && callChatId !== chatId) continue;
      if (chatIds && (!callChatId || !chatIds.has(callChatId))) continue;
      const recording = record(call.parsed.recording);
      if (recording?.mediaIsVideo !== true) continue;
      const fileUris = orderedRecordingFileUris(recording);
      if (!fileUris.length) continue;
      for (const fileUri of fileUris) referenced.add(fileUri);
      const startedAt = optionalString(call.parsed.startedAt);
      const durationSeconds = number(call.parsed.durationSec);
      discovered.push({
        key: `call:${sourceEName}:${call.id}`,
        fileUris,
        kind: 'call-recording',
        title: startedAt ? `Call recording · ${startedAt.slice(0, 10)}` : 'Call recording',
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(startedAt ? { createdAt: startedAt } : {}),
      });
    }
    return discovered;
  }

  private discoverMessageVideos(messages: Envelope[], referenced: Set<string>): DiscoveredVideo[] {
    const discovered: DiscoveredVideo[] = [];
    for (const message of messages) {
      const fileUris = messageVideoFileUris(message.parsed);
      if (!fileUris.length) continue;
      for (const fileUri of fileUris) referenced.add(fileUri);
      const file = record(message.parsed.file);
      const shape = optionalString(message.parsed.shape) ?? optionalString(message.parsed.type);
      discovered.push({
        key: `message:${message.id}:${fileUris.join(',')}`,
        fileUris,
        kind: 'video-message',
        title:
          optionalString(file?.name) ??
          optionalString(file?.filename) ??
          optionalString(message.parsed.content) ??
          'Meshenger video message',
        ...(number(message.parsed.durationSec) !== undefined
          ? { durationSeconds: number(message.parsed.durationSec) }
          : {}),
        ...(shape ? { shape } : {}),
        ...(optionalString(message.parsed.createdAt)
          ? { createdAt: optionalString(message.parsed.createdAt) }
          : {}),
      });
    }
    return discovered;
  }

  private discoverFileVideos(
    ownerEName: string,
    files: Envelope[],
    referenced: Set<string>,
  ): DiscoveredVideo[] {
    const discovered: DiscoveredVideo[] = [];
    for (const file of files) {
      const contentType =
        optionalString(file.parsed.contentType) ?? optionalString(file.parsed.mimeType);
      if (!contentType?.toLowerCase().startsWith('video/')) continue;
      const fileUri = optionalString(file.parsed.uri) ?? `w3ds://file?id=${ownerEName}/${file.id}`;
      if (!parseW3dsFileUri(fileUri) || referenced.has(fileUri)) continue;
      discovered.push({
        key: `file:${ownerEName}:${file.id}:${fileUri}`,
        fileUris: [fileUri],
        kind: 'file',
        title:
          optionalString(file.parsed.filename) ?? optionalString(file.parsed.name) ?? 'Video file',
        ...(optionalString(file.parsed.createdAt)
          ? { createdAt: optionalString(file.parsed.createdAt) }
          : {}),
      });
    }
    return discovered;
  }

  private async listChatReferences(owner: string, eVaultUri: string): Promise<ChatReference[]> {
    const references = await this.listEnvelopes(owner, eVaultUri, chatOntology);
    const unique = new Map<string, ChatReference>();
    for (const envelope of references) {
      const reference = chatReference(envelope.parsed);
      if (reference) unique.set(`${reference.groupEName}\u0000${reference.chatId}`, reference);
    }
    return [...unique.values()];
  }

  private async listEnvelopes(
    owner: string,
    eVaultUri: string,
    ontologyId: string,
  ): Promise<Envelope[]> {
    const results: Envelope[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.graphql(owner, eVaultUri, listQuery, {
        ontologyId,
        first: pageSize,
        after,
      });
      const connection = record(data.metaEnvelopes);
      for (const edge of asArray(connection?.edges)) {
        const node = record(record(edge)?.node);
        const id = optionalString(node?.id);
        const ontology = optionalString(node?.ontology);
        const parsed = parsePayload(node?.parsed);
        if (id && ontology && parsed) results.push({ id, ontology, parsed });
      }
      const info = record(connection?.pageInfo);
      if (info?.hasNextPage !== true) return results;
      after = optionalString(info.endCursor) ?? null;
      if (!after)
        throw new MeshengerVideoLibraryError(
          'The eVault returned an invalid page.',
          'remote_rejected',
          502,
        );
    }
    throw new MeshengerVideoLibraryError(
      'The video library is too large to read safely in one request.',
      'rate_limited',
      429,
    );
  }

  private async readEnvelope(owner: string, eVaultUri: string, id: string): Promise<Envelope> {
    const data = await this.graphql(owner, eVaultUri, readQuery, { id });
    const node = record(data.metaEnvelope);
    const envelopeId = optionalString(node?.id);
    const ontology = optionalString(node?.ontology);
    const parsed = parsePayload(node?.parsed);
    if (!envelopeId || !ontology || !parsed)
      throw new MeshengerVideoLibraryError(
        'The eVault returned an invalid video record.',
        'remote_rejected',
        502,
      );
    return { id: envelopeId, ontology, parsed };
  }

  private async resolveEVault(eName: string): Promise<string> {
    const url = new URL('/resolve', this.config.registryBaseUrl);
    url.searchParams.set('w3id', eName);
    const resolved = record(await this.requestJson(url, { method: 'GET' }));
    const uri = optionalString(resolved?.uri);
    if (optionalString(resolved?.ename) !== eName || !uri) {
      throw new MeshengerVideoLibraryError(
        'The W3DS registry could not resolve this video source.',
        'remote_rejected',
        502,
      );
    }
    return httpUrl(uri);
  }

  private async graphql(
    owner: string,
    eVaultUri: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<RecordValue> {
    const platformToken = await this.getPlatformToken();
    const body = record(
      await this.requestJson(new URL('/graphql', eVaultUri), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ENAME': owner,
          Authorization: `Bearer ${platformToken}`,
        },
        body: JSON.stringify({ query, variables }),
      }),
    );
    if (Array.isArray(body?.errors) && body.errors.length)
      throw new MeshengerVideoLibraryError(
        'The eVault rejected the video-library request.',
        'remote_rejected',
        502,
      );
    const data = record(body?.data);
    if (!data)
      throw new MeshengerVideoLibraryError(
        'The eVault returned invalid data.',
        'remote_rejected',
        502,
      );
    return data;
  }

  /** Registry-issued token used by the documented W3DS Web3 Adapter flow. */
  private async getPlatformToken(): Promise<string> {
    if (!this.platformToken) {
      this.platformToken = this.requestPlatformToken();
    }
    try {
      return await this.platformToken;
    } catch (error) {
      this.platformToken = undefined;
      throw error;
    }
  }

  private async requestPlatformToken(): Promise<string> {
    const payload = record(
      await this.requestJson(new URL('/platforms/certification', this.config.registryBaseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: this.config.platformName }),
      }),
    );
    const token = optionalString(payload?.token);
    if (!token) {
      throw new MeshengerVideoLibraryError(
        'The W3DS registry did not issue a platform credential.',
        'remote_rejected',
        502,
      );
    }
    return token;
  }

  private async requestJson(url: URL, init: RequestInit): Promise<unknown> {
    const deadline = Date.now() + retryBudgetMs;
    while (true) {
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          cache: 'no-store',
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch {
        throw new MeshengerVideoLibraryError(
          'The W3DS video source is unavailable.',
          'remote_unavailable',
          503,
        );
      }
      if (response.status === 429) {
        const retryAfter = retryAfterMs(response.headers.get('retry-after'));
        if (retryAfter !== undefined && Date.now() + retryAfter <= deadline) {
          await delay(retryAfter);
          continue;
        }
        throw new MeshengerVideoLibraryError(
          'The W3DS video source is busy. Please try again shortly.',
          'rate_limited',
          429,
        );
      }
      if (!response.ok)
        throw new MeshengerVideoLibraryError(
          'The W3DS video source rejected the request.',
          'remote_rejected',
          502,
        );
      try {
        return await response.json();
      } catch {
        throw new MeshengerVideoLibraryError(
          'The W3DS video source returned invalid data.',
          'remote_rejected',
          502,
        );
      }
    }
  }
}

export function createMeshengerVideoLibrary(
  env: Record<string, string | undefined> = process.env,
): MeshengerVideoLibrary {
  const registry = env.W3DS_REGISTRY_BASE_URL?.trim();
  const signingSecret = env.W3DS_AUTH_JWT_SECRET;
  if (!registry || !signingSecret || signingSecret.length < 32) {
    throw new MeshengerVideoLibraryError(
      'Meshenger videos are not configured for this Vidak deployment.',
      'not_configured',
      503,
    );
  }
  return new MeshengerVideoLibrary({
    registryBaseUrl: httpUrl(registry),
    platformName: env.W3DS_AUTH_PLATFORM_NAME?.trim() || 'vidak',
    signingSecret,
  });
}

export function createMeshengerVideoStreamId(grant: StreamGrant, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

export function verifyMeshengerVideoStreamId(value: string, secret: string): StreamGrant {
  const [encoded, signature, ...rest] = value.split('.');
  if (!encoded || !signature || rest.length) invalidStream();
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  )
    invalidStream();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    invalidStream();
  }
  const grant = record(parsed);
  const eName = optionalString(grant?.eName);
  const fileUri = optionalString(grant?.fileUri);
  const expiresAt = number(grant?.expiresAt);
  if (
    !eName ||
    !fileUri ||
    expiresAt === undefined ||
    !isEName(eName) ||
    !parseW3dsFileUri(fileUri)
  )
    invalidStream();
  if (expiresAt <= Date.now())
    throw new MeshengerVideoLibraryError(
      'This video link has expired. Refresh the library and try again.',
      'stream_expired',
      401,
    );
  return { eName, fileUri, expiresAt };
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function chatReference(payload: RecordValue): ChatReference | undefined {
  if (payload.isReference !== true) return undefined;
  const groupEName = optionalString(payload.canonicalOwnerEName);
  const chatId = optionalString(payload.canonicalChatId);
  if (!groupEName || !chatId || !isEName(groupEName)) return undefined;
  return { groupEName, chatId };
}
function isCurrentGroupMember(payload: RecordValue, eName: string): boolean {
  return (
    optionalString(payload.owner) === eName ||
    asArray(payload.admins).some((member) => member === eName) ||
    asArray(payload.members).some((member) => member === eName)
  );
}
function orderedRecordingFileUris(recording: RecordValue): string[] {
  const segments = asArray(recording.mediaSegments)
    .map(optionalString)
    .filter((fileUri): fileUri is string => Boolean(fileUri && parseW3dsFileUri(fileUri)));
  if (segments.length) return segments;
  const mediaUri = optionalString(recording.mediaUri);
  return mediaUri && parseW3dsFileUri(mediaUri) ? [mediaUri] : [];
}
function messageVideoFileUris(message: RecordValue): string[] {
  const type = optionalString(message.type)?.toLowerCase();
  const file = record(message.file);
  const contentType =
    optionalString(file?.contentType) ??
    optionalString(file?.mimeType) ??
    optionalString(message.contentType);
  const hasVideoType = type === 'video' || type === 'circle';
  const hasVideoFile = contentType?.toLowerCase().startsWith('video/') === true;
  if (!hasVideoType && !hasVideoFile) return [];

  const candidates = [
    ...asArray(message.mediaSegments),
    message.fileId,
    message.mediaUri,
    file?.uri,
    file?.fileUri,
  ];
  const unique = new Set<string>();
  for (const value of candidates) {
    const fileUri = optionalString(value);
    if (fileUri && parseW3dsFileUri(fileUri)) unique.add(fileUri);
  }
  return [...unique];
}
function parsePayload(value: unknown): RecordValue | undefined {
  if (record(value)) return record(value);
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}
function isEName(value: string): boolean {
  return /^@[^\s@/]+$/.test(value);
}
function requireEName(value: string): string {
  if (!isEName(value))
    throw new MeshengerVideoLibraryError(
      'Authentication is required.',
      'authentication_required',
      401,
    );
  return value;
}
function invalidStream(): never {
  throw new MeshengerVideoLibraryError('The video link is invalid.', 'invalid_stream', 401);
}
function participated(payload: RecordValue, eName: string): boolean {
  return (
    asArray(payload.participants).some((item) => item === eName) || payload.initiator === eName
  );
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function cacheMediaUrl(key: string, url: string, expiresAt: number): void {
  const now = Date.now();
  for (const [cachedKey, cached] of cachedMediaUrls) {
    if (cached.expiresAt <= now || cachedMediaUrls.size >= maxCachedMediaUrls)
      cachedMediaUrls.delete(cachedKey);
  }
  cachedMediaUrls.set(key, { url, expiresAt });
}
function retryAfterMs(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
function httpUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
      throw new Error();
    return url.toString();
  } catch {
    throw new MeshengerVideoLibraryError(
      'The W3DS video source is misconfigured.',
      'not_configured',
      503,
    );
  }
}
function safeMediaUrl(value: string): string {
  const url = new URL(httpUrl(value));
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    throw new MeshengerVideoLibraryError(
      'The video source URL is unsafe.',
      'unsafe_media_url',
      502,
    );
  }
  return url.toString();
}

/** Reject literal private, loopback, link-local, and unroutable destinations before proxying. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b) || parts.some((part) => Number(part) > 255))
    return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  return (
    host === '::' ||
    host === '::1' ||
    /^fe[89ab][0-9a-f]:/.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  );
}
