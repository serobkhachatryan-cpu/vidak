import { parseW3dsFileUri } from '../w3ds-official-file-client';
import { documentedOntologyId } from './documented-sources';
import {
  classifyAuthorizedMedia,
  constructW3dsFileUri,
  documentedMediaFilename,
  documentedMediaFileUris,
} from './media-eligibility';
import { isGenericVideoSpaceTitle, resolveVideoSpaceTitle } from './titles';
import type { VideoSpaceAccessScope } from './visibility';

export type VideoSpaceKind = 'call-recording' | 'video-message' | 'file';

export interface VideoSpaceEnvelope {
  id: string;
  ontology: string;
  parsed: Record<string, unknown>;
}

/** A File reference points at the canonical file record in another eVault. */
export interface FileRecordReferenceTarget {
  ownerEName: string;
  metaEnvelopeId: string;
  fileUri: string;
}

export type VideoAccessBasis = 'personal' | 'membership' | 'history';

export interface DiscoveredVideoRecord {
  key: string;
  fileUris: string[];
  kind: VideoSpaceKind;
  title: string;
  durationSeconds?: number | undefined;
  shape?: string | undefined;
  createdAt?: string | undefined;
  accessScope: VideoSpaceAccessScope;
  sourceId: 'w3ds-file' | 'file-record' | 'call-recording' | 'video-message';
  /** Server-only space identity for cache revalidation. Never sent to clients. */
  sourceSpaceKey?: string;
  accessBasis?: VideoAccessBasis;
}

const kindRank: Record<VideoSpaceKind, number> = {
  'call-recording': 3,
  'video-message': 2,
  file: 1,
};

const eNamePattern = /^@[^\s@/]+$/;

/**
 * Documented payload keys that identify the record subject/owner as an eName.
 * Official File.ownerId and Message.senderId are UUID-formatted in Ontology;
 * this repo already stores W3IDs in those fields and in senderEName/initiator.
 * Binding-document `subject` is included when present. Discovery vault, chat,
 * and group are never used here.
 */
const documentedOwnerKeys = [
  'ownerEName',
  'ownerId',
  'subject',
  'canonicalOwnerEName',
  'senderEName',
  'senderId',
  'initiator',
] as const;

export function videoSpaceFileIdentity(fileUris: readonly string[]): string {
  return [...fileUris]
    .map((uri) => uri.trim())
    .filter((uri) => Boolean(parseW3dsFileUri(uri)))
    .sort()
    .join('\n');
}

function optionalEName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const eName = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  return eNamePattern.test(eName) ? eName : undefined;
}

/**
 * Owner of a video record: documented subject/owner on the payload, else the
 * eName in a `w3ds://file` URI. Never the chat or group used to find it.
 */
export function documentedRecordOwnerEName(
  payload: Record<string, unknown>,
  fileUris: readonly string[] = [],
): string | undefined {
  for (const key of documentedOwnerKeys) {
    const owner = optionalEName(payload[key]);
    if (owner) return owner;
  }
  for (const fileUri of fileUris) {
    const parsed = parseW3dsFileUri(fileUri);
    if (parsed?.ownerEName) return parsed.ownerEName;
  }
  return undefined;
}

/**
 * Personal only when a documented owner/subject matches the authenticated
 * eName. Missing or foreign owners fail closed to shared (authorized, not mine).
 */
export function accessScopeForViewer(
  viewerEName: string,
  recordOwnerEName: string | undefined,
): VideoSpaceAccessScope {
  const viewer = optionalEName(viewerEName);
  const owner = optionalEName(recordOwnerEName);
  if (viewer && owner && viewer === owner) return 'personal';
  return 'shared';
}

function scopeForRecord(input: {
  viewerEName: string;
  payload: Record<string, unknown>;
  fileUris?: readonly string[];
  vaultOwnerEName?: string;
}): VideoSpaceAccessScope {
  // The canonical file URI identifies where the bytes live. A payload may
  // claim that the viewer owns a historical binding while the linked file is
  // actually owned by somebody else; never let that turn a shared file into a
  // misleading "Private" card.
  const fileOwners = (input.fileUris ?? [])
    .map((fileUri) => parseW3dsFileUri(fileUri)?.ownerEName)
    .filter((owner): owner is string => Boolean(owner));
  if (fileOwners.length > 0) {
    const viewer = optionalEName(input.viewerEName);
    return viewer && fileOwners.every((owner) => optionalEName(owner) === viewer)
      ? 'personal'
      : 'shared';
  }
  const owner =
    documentedRecordOwnerEName(input.payload, input.fileUris ?? []) ??
    optionalEName(input.vaultOwnerEName);
  return accessScopeForViewer(input.viewerEName, owner);
}

/**
 * A shared File row is frequently only a local reference. Its own envelope
 * does not contain playable bytes or a filename; the canonical owner and
 * envelope ID are the authorised source for both.
 */
export function fileRecordReferenceTarget(
  file: VideoSpaceEnvelope,
): FileRecordReferenceTarget | undefined {
  const isReference =
    file.parsed.isReference === true ||
    (typeof file.parsed.isReference === 'string' &&
      file.parsed.isReference.trim().toLocaleLowerCase() === 'true');
  if (!isReference) return undefined;
  const ownerEName = optionalEName(file.parsed.canonicalOwnerEName);
  const metaEnvelopeId = optionalString(file.parsed.canonicalFileId);
  if (!ownerEName || !metaEnvelopeId) return undefined;
  const fileUri = constructW3dsFileUri(ownerEName, metaEnvelopeId);
  if (!fileUri) return undefined;
  return { ownerEName, metaEnvelopeId, fileUri };
}

/**
 * One card per underlying file, even when several bindings point at it.
 * Prefer the viewer's own copy, then the richer media type.
 */
function hasUsefulTitle(item: DiscoveredVideoRecord): boolean {
  const title = item.title.trim();
  return (
    Boolean(title) &&
    title !== 'Untitled video' &&
    title !== 'Shared video' &&
    !isGenericVideoSpaceTitle(title)
  );
}

export function dedupeDiscoveredVideos(
  items: readonly DiscoveredVideoRecord[],
): DiscoveredVideoRecord[] {
  const unique = new Map<string, DiscoveredVideoRecord>();
  for (const item of items) {
    const identity = videoSpaceFileIdentity(item.fileUris);
    if (!identity) continue;
    const existing = unique.get(identity);
    if (!existing) {
      unique.set(identity, item);
      continue;
    }
    const existingHasUsefulTitle = hasUsefulTitle(existing);
    const nextHasUsefulTitle = hasUsefulTitle(item);
    const preferNext =
      (existing.accessScope === 'shared' && item.accessScope === 'personal') ||
      (existing.accessScope === item.accessScope &&
        (nextHasUsefulTitle !== existingHasUsefulTitle
          ? nextHasUsefulTitle
          : kindRank[item.kind] > kindRank[existing.kind]));
    if (preferNext) unique.set(identity, item);
  }
  return [...unique.values()];
}

export function discoverW3dsFileVideos(
  vaultOwnerEName: string,
  files: readonly VideoSpaceEnvelope[],
  referenced: Set<string>,
  viewerEName: string,
): DiscoveredVideoRecord[] {
  const ontology = documentedOntologyId('w3ds-file');
  const discovered: DiscoveredVideoRecord[] = [];
  for (const file of files) {
    if (file.ontology !== ontology && file.ontology !== 'w3ds-file-v1') continue;
    const fileUri = constructW3dsFileUri(vaultOwnerEName, file.id);
    if (!fileUri || referenced.has(fileUri)) continue;
    const contentType = optionalString(file.parsed.contentType);
    const decision = classifyAuthorizedMedia({
      payload: { type: 'file', ...file.parsed, mediaUri: fileUri },
      vaultOwnerEName,
      ...(contentType ? { resolvedContentType: contentType } : {}),
      resolvedOntology: file.ontology,
    });
    if (decision.status !== 'accept') continue;
    const accessScope = scopeForRecord({
      viewerEName,
      payload: file.parsed,
      fileUris: [fileUri],
      vaultOwnerEName,
    });
    discovered.push({
      key: `w3ds-file:${vaultOwnerEName}:${file.id}`,
      fileUris: [fileUri],
      kind: 'file',
      title: resolveVideoSpaceTitle({
        title: optionalString(file.parsed.title),
        caption: optionalString(file.parsed.caption),
        filename: optionalString(file.parsed.filename),
        kind: 'file',
        ...(optionalString(file.parsed.uploadedAt)
          ? { createdAt: optionalString(file.parsed.uploadedAt) }
          : {}),
      }),
      ...(optionalString(file.parsed.uploadedAt)
        ? { createdAt: optionalString(file.parsed.uploadedAt) }
        : {}),
      accessScope,
      sourceId: 'w3ds-file',
      sourceSpaceKey: vaultOwnerEName,
      accessBasis: accessScope === 'personal' ? 'personal' : 'membership',
    });
    referenced.add(fileUri);
  }
  return discovered;
}

export function discoverFileRecordVideos(
  vaultOwnerEName: string,
  files: readonly VideoSpaceEnvelope[],
  referenced: Set<string>,
  viewerEName: string,
): DiscoveredVideoRecord[] {
  const ontology = documentedOntologyId('file-record');
  const discovered: DiscoveredVideoRecord[] = [];
  for (const file of files) {
    if (file.ontology && file.ontology !== ontology) continue;
    const reference = fileRecordReferenceTarget(file);
    const fileUri =
      reference?.fileUri ??
      optionalW3dsFileUri(file.parsed.uri) ??
      optionalW3dsFileUri(file.parsed.url) ??
      constructW3dsFileUri(vaultOwnerEName, file.id);
    if (!fileUri || !parseW3dsFileUri(fileUri) || referenced.has(fileUri)) continue;
    const mime = optionalString(file.parsed.contentType) ?? optionalString(file.parsed.mimeType);
    const decision = classifyAuthorizedMedia({
      payload: { type: 'file', ...file.parsed, mediaUri: fileUri },
      vaultOwnerEName,
      ...(mime ? { resolvedContentType: mime } : {}),
      resolvedOntology: file.ontology || ontology,
    });
    if (decision.status !== 'accept') continue;
    const accessScope = scopeForRecord({
      viewerEName,
      payload: file.parsed,
      fileUris: [fileUri],
      vaultOwnerEName,
    });
    const title = resolveVideoSpaceTitle({
      title: optionalString(file.parsed.title),
      caption: optionalString(file.parsed.caption),
      filename: optionalString(file.parsed.filename) ?? optionalString(file.parsed.name),
      kind: 'file',
      ...(optionalString(file.parsed.createdAt)
        ? { createdAt: optionalString(file.parsed.createdAt) }
        : {}),
    });
    discovered.push({
      key: `file:${vaultOwnerEName}:${file.id}:${fileUri}`,
      fileUris: [fileUri],
      kind: 'file',
      // Reference metadata intentionally omits the remote filename. Keep a
      // truthful non-error label until the durable canonical lookup enriches it.
      title: reference && isGenericVideoSpaceTitle(title) ? 'Shared video' : title,
      ...(optionalString(file.parsed.createdAt)
        ? { createdAt: optionalString(file.parsed.createdAt) }
        : {}),
      accessScope,
      sourceId: 'file-record',
      sourceSpaceKey: vaultOwnerEName,
      accessBasis: reference ? 'personal' : accessScope === 'personal' ? 'personal' : 'membership',
    });
    // The canonical lookup below must still be able to add the richer target
    // record, so only non-reference File rows reserve their URI here.
    if (!reference) referenced.add(fileUri);
  }
  return discovered;
}

export function discoverCallRecordingVideos(input: {
  viewerEName: string;
  sourceEName: string;
  calls: readonly VideoSpaceEnvelope[];
  referenced: Set<string>;
  chatId?: string;
  chatIds?: ReadonlySet<string>;
}): DiscoveredVideoRecord[] {
  const discovered: DiscoveredVideoRecord[] = [];
  for (const call of input.calls) {
    if (!isAuthorizedCallParticipant(call.parsed, input.viewerEName)) continue;
    const callChatId = optionalString(call.parsed.chatId);
    if (input.chatId && callChatId !== input.chatId) continue;
    if (input.chatIds && (!callChatId || !input.chatIds.has(callChatId))) continue;
    const recording = record(call.parsed.recording);
    if (recording?.mediaIsVideo !== true) continue;
    const fileUris = orderedRecordingFileUris(recording);
    if (!fileUris.length) continue;
    for (const fileUri of fileUris) input.referenced.add(fileUri);
    const startedAt = optionalString(call.parsed.startedAt);
    const durationSeconds = number(call.parsed.durationSec);
    const accessScope = scopeForRecord({
      viewerEName: input.viewerEName,
      payload: call.parsed,
      fileUris,
      vaultOwnerEName: input.sourceEName,
    });
    discovered.push({
      key: `call:${input.sourceEName}:${call.id}`,
      fileUris,
      kind: 'call-recording',
      title: resolveVideoSpaceTitle({
        title: optionalString(call.parsed.title),
        caption: optionalString(call.parsed.caption),
        conversationTitle:
          optionalString(call.parsed.chatTitle) ?? optionalString(call.parsed.title),
        ...(startedAt ? { createdAt: startedAt } : {}),
        kind: 'call-recording',
      }),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(startedAt ? { createdAt: startedAt } : {}),
      accessScope,
      sourceId: 'call-recording',
      sourceSpaceKey: input.sourceEName,
      accessBasis: accessScope === 'personal' ? 'personal' : 'history',
    });
  }
  return discovered;
}

export function discoverVideoMessageVideos(
  messages: readonly VideoSpaceEnvelope[],
  referenced: Set<string>,
  viewerEName: string,
  sourceSpaceKey?: string,
): DiscoveredVideoRecord[] {
  const discovered: DiscoveredVideoRecord[] = [];
  for (const message of messages) {
    const decision = classifyAuthorizedMedia({
      payload: message.parsed,
      ...(sourceSpaceKey ? { vaultOwnerEName: sourceSpaceKey } : {}),
    });
    if (decision.status !== 'accept') continue;
    const fileUris = [decision.fileUri];
    for (const fileUri of fileUris) referenced.add(fileUri);
    const shape = optionalString(message.parsed.shape) ?? optionalString(message.parsed.type);
    const accessScope = scopeForRecord({
      viewerEName,
      payload: message.parsed,
      fileUris,
      ...(sourceSpaceKey ? { vaultOwnerEName: sourceSpaceKey } : {}),
    });
    discovered.push({
      key: `message:${message.id}:${fileUris.join(',')}`,
      fileUris,
      kind: 'video-message',
      title: resolveVideoSpaceTitle({
        title: optionalString(message.parsed.title),
        caption: optionalString(message.parsed.caption),
        filename: documentedMediaFilename(message.parsed),
        messageText: optionalString(message.parsed.content),
        conversationTitle: optionalString(message.parsed.chatTitle),
        ...(optionalString(message.parsed.createdAt)
          ? { createdAt: optionalString(message.parsed.createdAt) }
          : {}),
        kind: 'video-message',
      }),
      ...(number(message.parsed.durationSec) !== undefined
        ? { durationSeconds: number(message.parsed.durationSec) }
        : {}),
      ...(shape ? { shape } : {}),
      ...(optionalString(message.parsed.createdAt)
        ? { createdAt: optionalString(message.parsed.createdAt) }
        : {}),
      accessScope,
      sourceId: 'video-message',
      ...(sourceSpaceKey ? { sourceSpaceKey } : {}),
      accessBasis: accessScope === 'personal' ? 'personal' : 'history',
    });
  }
  return discovered;
}

export function isAuthorizedCallParticipant(
  payload: Record<string, unknown>,
  eName: string,
): boolean {
  return (
    asArray(payload.participants).some((item) => item === eName) || payload.initiator === eName
  );
}

export function orderedRecordingFileUris(recording: Record<string, unknown>): string[] {
  const segments = asArray(recording.mediaSegments)
    .map(optionalString)
    .filter((fileUri): fileUri is string => Boolean(fileUri && parseW3dsFileUri(fileUri)));
  if (segments.length) return segments;
  const mediaUri = optionalString(recording.mediaUri);
  return mediaUri && parseW3dsFileUri(mediaUri) ? [mediaUri] : [];
}

/**
 * Documented Message attachment URIs that can identify an authorized video.
 * Official Message.type is text | image | file | system with mediaUrl on
 * image/file. This repo also already stores video/circle on the same ontology.
 */
export function messageVideoFileUris(
  message: Record<string, unknown>,
  vaultOwnerEName?: string,
): string[] {
  const decision = classifyAuthorizedMedia({
    payload: message,
    ...(vaultOwnerEName ? { vaultOwnerEName } : {}),
  });
  if (decision.status === 'accept' || decision.status === 'resolve') return [decision.fileUri];
  return documentedMediaFileUris(message, vaultOwnerEName);
}

export function isDocumentedVideoAttachment(message: Record<string, unknown>): boolean {
  return classifyAuthorizedMedia({ payload: message }).status === 'accept';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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

function optionalW3dsFileUri(value: unknown): string | undefined {
  const fileUri = optionalString(value);
  return fileUri && parseW3dsFileUri(fileUri) ? fileUri : undefined;
}
