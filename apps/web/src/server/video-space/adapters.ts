import { parseW3dsFileUri } from '../w3ds-official-file-client';
import { documentedOntologyId } from './documented-sources';
import type { VideoSpaceAccessScope } from './visibility';

export type VideoSpaceKind = 'call-recording' | 'video-message' | 'file';

export interface VideoSpaceEnvelope {
  id: string;
  ontology: string;
  parsed: Record<string, unknown>;
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

export function videoSpaceFileIdentity(fileUris: readonly string[]): string {
  return [...fileUris]
    .map((uri) => uri.trim())
    .filter((uri) => Boolean(parseW3dsFileUri(uri)))
    .sort()
    .join('\n');
}

/**
 * One card per underlying file, even when several bindings point at it.
 * Prefer the viewer's own copy, then the richer media type.
 */
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
    const preferNext =
      (existing.accessScope === 'shared' && item.accessScope === 'personal') ||
      (existing.accessScope === item.accessScope && kindRank[item.kind] > kindRank[existing.kind]);
    if (preferNext) unique.set(identity, item);
  }
  return [...unique.values()];
}

export function discoverW3dsFileVideos(
  ownerEName: string,
  files: readonly VideoSpaceEnvelope[],
  referenced: Set<string>,
  accessScope: VideoSpaceAccessScope,
): DiscoveredVideoRecord[] {
  const ontology = documentedOntologyId('w3ds-file');
  const discovered: DiscoveredVideoRecord[] = [];
  for (const file of files) {
    if (file.ontology !== ontology && file.ontology !== 'w3ds-file-v1') continue;
    const contentType = optionalString(file.parsed.contentType);
    if (!contentType?.toLowerCase().startsWith('video/')) continue;
    const fileUri = `w3ds://file?id=${ownerEName}/${file.id}`;
    if (!parseW3dsFileUri(fileUri) || referenced.has(fileUri)) continue;
    discovered.push({
      key: `w3ds-file:${ownerEName}:${file.id}`,
      fileUris: [fileUri],
      kind: 'file',
      title: optionalString(file.parsed.filename) ?? 'Video',
      ...(optionalString(file.parsed.uploadedAt)
        ? { createdAt: optionalString(file.parsed.uploadedAt) }
        : {}),
      accessScope,
      sourceId: 'w3ds-file',
      sourceSpaceKey: ownerEName,
      accessBasis: accessScope === 'personal' ? 'personal' : 'membership',
    });
    referenced.add(fileUri);
  }
  return discovered;
}

export function discoverFileRecordVideos(
  ownerEName: string,
  files: readonly VideoSpaceEnvelope[],
  referenced: Set<string>,
  accessScope: VideoSpaceAccessScope,
): DiscoveredVideoRecord[] {
  const ontology = documentedOntologyId('file-record');
  const discovered: DiscoveredVideoRecord[] = [];
  for (const file of files) {
    if (file.ontology && file.ontology !== ontology) continue;
    const contentType =
      optionalString(file.parsed.contentType) ?? optionalString(file.parsed.mimeType);
    if (!contentType?.toLowerCase().startsWith('video/')) continue;
    const fileUri =
      optionalW3dsFileUri(file.parsed.uri) ??
      optionalW3dsFileUri(file.parsed.url) ??
      `w3ds://file?id=${ownerEName}/${file.id}`;
    if (!parseW3dsFileUri(fileUri) || referenced.has(fileUri)) continue;
    discovered.push({
      key: `file:${ownerEName}:${file.id}:${fileUri}`,
      fileUris: [fileUri],
      kind: 'file',
      title: optionalString(file.parsed.filename) ?? optionalString(file.parsed.name) ?? 'Video',
      ...(optionalString(file.parsed.createdAt)
        ? { createdAt: optionalString(file.parsed.createdAt) }
        : {}),
      accessScope,
      sourceId: 'file-record',
      sourceSpaceKey: ownerEName,
      accessBasis: accessScope === 'personal' ? 'personal' : 'membership',
    });
    referenced.add(fileUri);
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
    discovered.push({
      key: `call:${input.sourceEName}:${call.id}`,
      fileUris,
      kind: 'call-recording',
      title: startedAt ? `Call recording · ${startedAt.slice(0, 10)}` : 'Call recording',
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(startedAt ? { createdAt: startedAt } : {}),
      accessScope: input.sourceEName === input.viewerEName ? 'personal' : 'shared',
      sourceId: 'call-recording',
      sourceSpaceKey: input.sourceEName,
      accessBasis: input.sourceEName === input.viewerEName ? 'personal' : 'history',
    });
  }
  return discovered;
}

export function discoverVideoMessageVideos(
  messages: readonly VideoSpaceEnvelope[],
  referenced: Set<string>,
  accessScope: VideoSpaceAccessScope,
  sourceSpaceKey?: string,
): DiscoveredVideoRecord[] {
  const discovered: DiscoveredVideoRecord[] = [];
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
        optionalString(file?.displayName) ??
        optionalString(message.parsed.content) ??
        'Video',
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
export function messageVideoFileUris(message: Record<string, unknown>): string[] {
  if (!isDocumentedVideoAttachment(message)) return [];

  const file = record(message.file);
  const candidates = [
    ...asArray(message.mediaSegments),
    message.fileId,
    message.mediaUri,
    message.mediaUrl,
    file?.uri,
    file?.fileUri,
    file?.url,
  ];
  const unique = new Set<string>();
  for (const value of candidates) {
    const fileUri = optionalW3dsFileUri(value);
    if (fileUri) unique.add(fileUri);
  }
  return [...unique];
}

export function isDocumentedVideoAttachment(message: Record<string, unknown>): boolean {
  const type = optionalString(message.type)?.toLowerCase();
  const file = record(message.file);
  const contentType =
    optionalString(file?.contentType) ??
    optionalString(file?.mimeType) ??
    optionalString(message.contentType) ??
    optionalString(message.mimeType);
  const mime = contentType?.toLowerCase();
  if (isExplicitlyNonVideoMime(mime)) return false;
  if (type === 'video' || type === 'circle' || type === 'file') return true;
  if (mime?.startsWith('video/') === true) return true;
  return false;
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

function isExplicitlyNonVideoMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return (
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('text/') ||
    mime === 'application/pdf'
  );
}
