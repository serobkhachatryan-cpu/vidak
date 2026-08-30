import { createHmac, timingSafeEqual } from 'node:crypto';
import 'server-only';

import type { AuthUser } from '@w3ds/auth';
import {
  type DiscoveredVideoRecord,
  dedupeDiscoveredVideos,
  discoverCallRecordingVideos,
  discoverFileRecordVideos,
  discoverVideoMessageVideos,
  discoverW3dsFileVideos,
} from './video-space/adapters';
import { documentedAuthorizationOntologies, documentedOntologyId } from './video-space/documented-sources';
import {
  type VideoSpaceAccessScope,
  type VideoSpaceVisibility,
  visibilityForEVaultVideo,
} from './video-space/visibility';
import { parseW3dsFileUri } from './w3ds-official-file-client';

const callSessionOntology = documentedOntologyId('call-recording');
const groupManifestOntology = documentedAuthorizationOntologies.groupManifest;
const chatOntology = documentedAuthorizationOntologies.chat;
const messageOntology = documentedOntologyId('video-message');
const fileOntology = documentedOntologyId('file-record');
const w3dsFileOntology = documentedOntologyId('w3ds-file');
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
export type EVaultVideoAccessScope = VideoSpaceAccessScope;

export interface MeshengerVideo {
  id: string;
  kind: MeshengerVideoKind;
  title: string;
  durationSeconds?: number;
  shape?: string;
  createdAt?: string;
  /** Whether the video is in the person's vault or an authorised shared vault. */
  accessScope: EVaultVideoAccessScope;
  /** Viewer-facing visibility. Never inferred as public from a missing ACL. */
  visibility: VideoSpaceVisibility;
  /** Ordered, opaque, signed, account-bound references. Never CDN URLs. */
  streamIds: string[];
}

/** A chat surfaced from the user's own vault or a currently-authorized group. */
export interface MeshengerConversation {
  id: string;
  ownerEName: string;
  chatId: string;
  kind: 'personal' | 'group';
  title: string;
  participantCount?: number | undefined;
  role?: 'admin' | 'participant' | undefined;
  updatedAt?: string | undefined;
}

/** Safe display metadata for an authorized Meshenger message. */
export interface MeshengerMessage {
  id: string;
  ownerEName: string;
  chatId?: string | undefined;
  type: string;
  senderEName?: string | undefined;
  content?: string | undefined;
  replyToId?: string | undefined;
  createdAt?: string | undefined;
  edited: boolean;
}

export interface MeshengerLibrary {
  items: MeshengerVideo[];
  conversations: MeshengerConversation[];
  messages: MeshengerMessage[];
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
type DiscoveredVideo = DiscoveredVideoRecord;
interface ChatReference {
  groupEName: string;
  chatId: string;
  type?: string | undefined;
}
interface GroupDiscovery {
  videos: DiscoveredVideo[];
  conversations: MeshengerConversation[];
  messages: MeshengerMessage[];
}

const listQuery = `query MeshengerVideos($ontologyId: ID!, $first: Int!, $after: String) {
  metaEnvelopes(filter: { ontologyId: $ontologyId }, first: $first, after: $after) {
    edges { node { id ontology parsed } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const chatMessagesQuery = `query MeshengerChatMessages($ontologyId: ID!, $chatId: String!, $first: Int!, $after: String) {
  metaEnvelopes(filter: { ontologyId: $ontologyId, search: { term: $chatId, fields: ["chatId"], mode: EXACT } }, first: $first, after: $after) {
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
    return (await this.listWithContext(user)).items;
  }

  /**
   * A private, read-only view of Meshenger records the current person can
   * discover. Group data is returned only after current membership is checked
   * against the group manifest on that group's eVault.
   */
  async listWithContext(user: Pick<AuthUser, 'eName' | 'eVaultUri'>): Promise<MeshengerLibrary> {
    const eName = requireEName(user.eName);
    const eVaultUri = user.eVaultUri ? httpUrl(user.eVaultUri) : await this.resolveEVault(eName);
    // eVaults throttle bursts. Scan each source in order so a first historical
    // import does not turn three independent reads into a simultaneous spike.
    const calls = await this.listEnvelopes(eName, eVaultUri, callSessionOntology);
    const chatEnvelopes = await this.listEnvelopes(eName, eVaultUri, chatOntology);
    const chatReferences = chatReferencesFromEnvelopes(chatEnvelopes);
    const messages = await this.listEnvelopes(eName, eVaultUri, messageOntology);
    const files = await this.listEnvelopes(eName, eVaultUri, fileOntology);
    const rawFiles = await this.listEnvelopes(eName, eVaultUri, w3dsFileOntology);
    const referenced = new Set<string>();
    const found = await this.discoverCallVideos({
      viewerEName: eName,
      sourceEName: eName,
      sourceEVaultUri: eVaultUri,
      calls,
      referenced,
    });
    found.push(...this.discoverMessageVideos(messages, referenced, 'personal'));
    found.push(...this.discoverFileVideos(eName, files, referenced, 'personal'));
    found.push(...this.discoverRawFileVideos(eName, rawFiles, referenced, 'personal'));
    const group = await this.discoverGroupVideos(eName, chatReferences, referenced);
    found.push(...group.videos);
    const direct = await this.discoverDirectChatMedia(eName, chatReferences, referenced);
    found.push(...direct.videos);

    const unique = dedupeDiscoveredVideos(found);
    return {
      items: unique
        .map((item) => ({
          id: item.key,
          kind: item.kind,
          title: item.title,
          ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
          ...(item.shape ? { shape: item.shape } : {}),
          ...(item.createdAt ? { createdAt: item.createdAt } : {}),
          accessScope: item.accessScope,
          visibility: visibilityForEVaultVideo({
            accessScope: item.accessScope,
            viewerEName: eName,
          }),
          streamIds: item.fileUris.map((fileUri) =>
            createMeshengerVideoStreamId(
              { eName, fileUri, expiresAt: Date.now() + streamLifetimeMs },
              this.config.signingSecret,
            ),
          ),
        }))
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
      conversations: uniqueConversations([
        ...chatEnvelopesToConversations(eName, chatReferences, chatEnvelopes),
        ...group.conversations,
        ...direct.conversations,
      ]),
      messages: uniqueMessages([
        ...messages.map((message) => toMeshengerMessage(eName, message)),
        ...group.messages,
        ...direct.messages,
      ]).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    };
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

  /**
   * Drops a cached signed source after the upstream reports an expired or denied
   * media URL. The next request resolves the File envelope again.
   */
  invalidateMediaUrl(user: Pick<AuthUser, 'eName'>, streamId: string): void {
    const grant = verifyMeshengerVideoStreamId(streamId, this.config.signingSecret);
    if (grant.eName !== requireEName(user.eName)) {
      throw new MeshengerVideoLibraryError(
        'This video is not available to this account.',
        'invalid_stream',
        403,
      );
    }
    cachedMediaUrls.delete(`${grant.eName}\u0000${grant.fileUri}`);
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
   * A trusted chat-reference chain can grant access to that group's video
   * messages, call recordings, and ordinary video File envelopes. Read each
   * group once so multiple references cannot multiply eVault traffic or cards.
   */
  private async discoverGroupVideos(
    viewerEName: string,
    chatReferences: ChatReference[],
    referenced: Set<string>,
  ): Promise<GroupDiscovery> {
    const chatsByGroup = new Map<string, Set<string>>();
    for (const reference of chatReferences) {
      const chatIds = chatsByGroup.get(reference.groupEName) ?? new Set<string>();
      chatIds.add(reference.chatId);
      chatsByGroup.set(reference.groupEName, chatIds);
    }

    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messageRecords: MeshengerMessage[] = [];
    for (const [groupEName, chatIds] of chatsByGroup) {
      try {
        const groupEVaultUri = await this.resolveEVault(groupEName);
        const manifests = await this.listEnvelopes(
          groupEName,
          groupEVaultUri,
          groupManifestOntology,
        );
        const manifest = manifests.find((item) => isCurrentGroupMember(item.parsed, viewerEName));
        if (!manifest) {
          continue;
        }
        const participantCount = groupParticipantCount(manifest.parsed);
        const role = groupRole(manifest.parsed, viewerEName);
        const updatedAt = optionalString(manifest.parsed.updatedAt);
        for (const chatId of chatIds) {
          conversations.push({
            id: `${groupEName}:${chatId}`,
            ownerEName: groupEName,
            chatId,
            kind: 'group',
            title: optionalString(manifest.parsed.name) ?? 'Group',
            ...(participantCount ? { participantCount } : {}),
            ...(role ? { role } : {}),
            ...(updatedAt ? { updatedAt } : {}),
          });
        }
        const calls = await this.listEnvelopes(groupEName, groupEVaultUri, callSessionOntology);
        videos.push(
          ...(await this.discoverCallVideos({
            viewerEName,
            sourceEName: groupEName,
            sourceEVaultUri: groupEVaultUri,
            calls,
            chatIds,
            referenced,
          })),
        );
        // Messages live on their authors' vaults. The group vault is retained
        // as a source for older/system records, while GroupManifest provides
        // the current member eNames needed for the authoritative fan-in.
        const messageSources = new Set([...groupMemberENames(manifest.parsed), groupEName]);
        for (const chatId of chatIds) {
          for (const authorEName of messageSources) {
            try {
              const authorEVaultUri =
                authorEName === groupEName ? groupEVaultUri : await this.resolveEVault(authorEName);
              const authorMessages = await this.listMessagesForChat(
                authorEName,
                authorEVaultUri,
                chatId,
              );
              videos.push(...this.discoverMessageVideos(authorMessages, referenced, 'shared'));
              messageRecords.push(
                ...authorMessages.map((message) => toMeshengerMessage(authorEName, message)),
              );
            } catch {
              // Membership can change while a library refresh is in flight.
              // One unavailable author must not hide other chat sources.
            }
          }
        }
        const files = await this.listEnvelopes(groupEName, groupEVaultUri, fileOntology);
        videos.push(...this.discoverFileVideos(groupEName, files, referenced, 'shared'));
        const rawFiles = await this.listEnvelopes(groupEName, groupEVaultUri, w3dsFileOntology);
        videos.push(...this.discoverRawFileVideos(groupEName, rawFiles, referenced, 'shared'));
      } catch {
        // A stale chat reference or a group that no longer grants access must
        // not hide the rest of a person's authorised video library.
      }
    }
    return { videos, conversations, messages: messageRecords };
  }

  /**
   * Direct chat references are hosted on another person's vault, not a group
   * vault, so they have no GroupManifest. The reference itself is the
   * discovery grant; we still require that its canonical Chat exists and only
   * return messages and call recordings for that exact chat id.
   */
  private async discoverDirectChatMedia(
    viewerEName: string,
    references: ChatReference[],
    referenced: Set<string>,
  ): Promise<GroupDiscovery> {
    const byOwner = new Map<string, Set<string>>();
    for (const reference of references) {
      if (reference.groupEName === viewerEName) continue;
      const chatIds = byOwner.get(reference.groupEName) ?? new Set<string>();
      chatIds.add(reference.chatId);
      byOwner.set(reference.groupEName, chatIds);
    }

    const videos: DiscoveredVideo[] = [];
    const conversations: MeshengerConversation[] = [];
    const messages: MeshengerMessage[] = [];
    for (const [ownerEName, chatIds] of byOwner) {
      try {
        const eVaultUri = await this.resolveEVault(ownerEName);
        const chats = await this.listEnvelopes(ownerEName, eVaultUri, chatOntology);
        const canonicalChats = new Map<string, Envelope>();
        for (const chat of chats) {
          if (chat.parsed.isReference === true) continue;
          if (optionalString(chat.parsed.type)?.toLowerCase() === 'group') continue;
          const chatId = optionalString(chat.parsed.id) ?? chat.id;
          if (chatIds.has(chatId)) canonicalChats.set(chatId, chat);
        }
        if (!canonicalChats.size) continue;

        for (const [chatId, chat] of canonicalChats) {
          const participants = asArray(chat.parsed.participantIds).filter(
            (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
          );
          const updatedAt = optionalString(chat.parsed.updatedAt);
          conversations.push({
            id: `${ownerEName}:${chatId}`,
            ownerEName,
            chatId,
            kind: 'personal',
            title: optionalString(chat.parsed.name) ?? 'Conversation',
            ...(participants.length ? { participantCount: participants.length } : {}),
            ...(updatedAt ? { updatedAt } : {}),
          });
        }

        for (const chatId of canonicalChats.keys()) {
          const authorMessages = await this.listMessagesForChat(ownerEName, eVaultUri, chatId);
          videos.push(...this.discoverMessageVideos(authorMessages, referenced, 'shared'));
          messages.push(
            ...authorMessages.map((message) => toMeshengerMessage(ownerEName, message)),
          );
        }

        const calls = await this.listEnvelopes(ownerEName, eVaultUri, callSessionOntology);
        videos.push(
          ...(await this.discoverCallVideos({
            viewerEName,
            sourceEName: ownerEName,
            sourceEVaultUri: eVaultUri,
            calls,
            chatIds,
            referenced,
          })),
        );
      } catch {
        // A stale direct-chat reference must not leak any other source or
        // prevent the rest of the signed-in person's library from loading.
      }
    }
    return { videos, conversations, messages };
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
    const resolved: Envelope[] = [];
    for (const source of calls) {
      const call = await this.resolveCall(sourceEName, sourceEVaultUri, source);
      if (call) resolved.push(call);
    }
    return discoverCallRecordingVideos({
      viewerEName,
      sourceEName,
      calls: resolved,
      referenced,
      ...(chatId ? { chatId } : {}),
      ...(chatIds ? { chatIds } : {}),
    });
  }

  private discoverMessageVideos(
    messages: Envelope[],
    referenced: Set<string>,
    accessScope: EVaultVideoAccessScope,
  ): DiscoveredVideo[] {
    return discoverVideoMessageVideos(messages, referenced, accessScope);
  }

  private discoverFileVideos(
    ownerEName: string,
    files: Envelope[],
    referenced: Set<string>,
    accessScope: EVaultVideoAccessScope,
  ): DiscoveredVideo[] {
    return discoverFileRecordVideos(ownerEName, files, referenced, accessScope);
  }

  /** Discovers authorised video directly from the W3DS uploadFile record. */
  private discoverRawFileVideos(
    ownerEName: string,
    files: Envelope[],
    referenced: Set<string>,
    accessScope: EVaultVideoAccessScope,
  ): DiscoveredVideo[] {
    return discoverW3dsFileVideos(ownerEName, files, referenced, accessScope);
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

  /** Query a single chat on one author vault; never enumerate that vault's unrelated messages. */
  private async listMessagesForChat(
    owner: string,
    eVaultUri: string,
    chatId: string,
  ): Promise<Envelope[]> {
    const results: Envelope[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await this.graphql(owner, eVaultUri, chatMessagesQuery, {
        ontologyId: messageOntology,
        chatId,
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
      'The authorised chat is too large to read safely in one request.',
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
      'eVault videos are not configured for this Vidak deployment.',
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
  const type = optionalString(payload.type)?.toLowerCase();
  return { groupEName, chatId, ...(type ? { type } : {}) };
}
function chatReferencesFromEnvelopes(envelopes: Envelope[]): ChatReference[] {
  const unique = new Map<string, ChatReference>();
  for (const envelope of envelopes) {
    const reference = chatReference(envelope.parsed);
    if (reference) unique.set(`${reference.groupEName}::${reference.chatId}`, reference);
  }
  return [...unique.values()];
}
function chatEnvelopesToConversations(
  ownerEName: string,
  chatReferences: ChatReference[],
  envelopes: Envelope[],
): MeshengerConversation[] {
  const referencedGroups = new Set(
    chatReferences.map((reference) => `${reference.groupEName}::${reference.chatId}`),
  );
  return envelopes.flatMap((envelope) => {
    if (envelope.parsed.isReference === true) return [];
    const chatId = optionalString(envelope.parsed.id) ?? envelope.id;
    const canonicalOwner = optionalString(envelope.parsed.canonicalOwnerEName) ?? ownerEName;
    if (referencedGroups.has(`${canonicalOwner}::${chatId}`)) return [];
    const participantIds = asArray(envelope.parsed.participantIds).filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    );
    const updatedAt = optionalString(envelope.parsed.updatedAt);
    return [
      {
        id: `${ownerEName}:${chatId}`,
        ownerEName,
        chatId,
        kind: 'personal',
        title: optionalString(envelope.parsed.name) ?? 'Conversation',
        ...(participantIds.length ? { participantCount: participantIds.length } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      },
    ];
  });
}
function toMeshengerMessage(ownerEName: string, envelope: Envelope): MeshengerMessage {
  const parsed = envelope.parsed;
  const chatId = optionalString(parsed.chatId);
  const senderEName = optionalString(parsed.senderEName);
  const content = optionalString(parsed.content);
  const replyToId = optionalString(parsed.replyTo);
  const createdAt = optionalString(parsed.createdAt);
  return {
    id: `${ownerEName}:${envelope.id}`,
    ownerEName,
    ...(chatId ? { chatId } : {}),
    type: optionalString(parsed.type) ?? 'message',
    ...(senderEName ? { senderEName } : {}),
    ...(content ? { content } : {}),
    ...(replyToId ? { replyToId } : {}),
    ...(createdAt ? { createdAt } : {}),
    edited: parsed.edited === true,
  };
}
function uniqueConversations(items: MeshengerConversation[]): MeshengerConversation[] {
  const unique = new Map<string, MeshengerConversation>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
function uniqueMessages(items: MeshengerMessage[]): MeshengerMessage[] {
  const unique = new Map<string, MeshengerMessage>();
  for (const item of items) unique.set(item.id, item);
  return [...unique.values()];
}
function isCurrentGroupMember(payload: RecordValue, eName: string): boolean {
  return (
    optionalString(payload.owner) === eName ||
    asArray(payload.admins).some((member) => member === eName) ||
    asArray(payload.members).some((member) => member === eName)
  );
}
function groupRole(payload: RecordValue, eName: string): 'admin' | 'participant' | undefined {
  if (optionalString(payload.owner) === eName) return 'admin';
  if (asArray(payload.admins).some((member) => member === eName)) return 'admin';
  if (asArray(payload.members).some((member) => member === eName)) return 'participant';
  return undefined;
}
function groupParticipantCount(payload: RecordValue): number {
  const people = new Set<string>();
  const owner = optionalString(payload.owner);
  if (owner) people.add(owner);
  for (const member of [...asArray(payload.admins), ...asArray(payload.members)]) {
    if (typeof member === 'string' && member.trim()) people.add(member);
  }
  return people.size;
}
function groupMemberENames(payload: RecordValue): string[] {
  const people = new Set<string>();
  const owner = optionalString(payload.owner);
  if (owner) people.add(owner);
  for (const member of [...asArray(payload.admins), ...asArray(payload.members)]) {
    if (typeof member === 'string' && isEName(member)) people.add(member);
  }
  return [...people];
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
