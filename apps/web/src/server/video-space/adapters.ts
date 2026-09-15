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
  /**
   * Internal discovery context, never part of a source envelope. A referenced
   * CallSession can be resolved from a vault other than the listing vault, so
   * its exact authorization record must retain its own canonical home.
   */
  sourceCallSessionVault?: string;
}

/** A File reference points at the canonical file record in another eVault. */
export interface FileRecordReferenceTarget {
  ownerEName: string;
  metaEnvelopeId: string;
  fileUri: string;
}

/**
 * Why the viewer may currently access a non-personal record. A `reference`
 * basis is a File reference in the viewer's own vault; it is re-read before
 * listing or playing, so it is neither mistaken for a group grant nor trusted
 * merely because it was discovered earlier.
 */
export type VideoAccessBasis = 'personal' | 'membership' | 'history' | 'reference';

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
  /**
   * Server-only current GroupManifest envelope verified during inventory.
   * It is copied only into a sealed playback grant, never into card JSON.
   */
  sourceGroupManifestId?: string;
  /** Server-only direct-chat identity for current shared-playback verification. */
  sourceChatId?: string;
  /** Server-only viewer-vault Chat envelope used for an O(1) current direct-share proof. */
  sourceViewerChatGrantId?: string;
  /** Canonical CallSession envelope that carries the recording references. */
  sourceCallSessionId?: string;
  /** Canonical vault containing `sourceCallSessionId` and its source Chat. */
  sourceCallSessionVault?: string;
  /** Optional media-storage vault named inside the CallSession recording. */
  sourceRecordingVault?: string;
  /** Server-only source relationship kind; only direct chats may use the source bridge. */
  sourceChatKind?: 'direct' | 'group';
  /** Server-only local File-reference envelope used to prove a direct share. */
  sourceReferenceId?: string;
  /** Canonical File envelope that the local reference must still target. */
  sourceReferenceFileId?: string;
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

function sameEName(left: string, right: string): boolean {
  const normalizedLeft = optionalEName(left);
  return Boolean(normalizedLeft && normalizedLeft === optionalEName(right));
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

/**
 * Two bindings for the same file can represent the same direct historical
 * share while carrying different presentation metadata.  The exact
 * viewer-vault Chat envelope is authorization context rather than display
 * metadata, so preserve it across that otherwise ordinary card merge.  The
 * envelope is still re-read and validated at playback; it can never prove a
 * different source, chat, or file accessible.
 */
function directHistoryViewerChatGrantId(
  existing: DiscoveredVideoRecord,
  candidate: DiscoveredVideoRecord,
): string | undefined {
  if (
    existing.accessScope !== 'shared' ||
    candidate.accessScope !== 'shared' ||
    existing.accessBasis !== 'history' ||
    candidate.accessBasis !== 'history' ||
    !existing.sourceSpaceKey ||
    !candidate.sourceSpaceKey ||
    !sameEName(existing.sourceSpaceKey, candidate.sourceSpaceKey) ||
    !existing.sourceChatId ||
    existing.sourceChatId !== candidate.sourceChatId
  ) {
    return undefined;
  }
  // A newly rediscovered envelope is preferred when present, but retaining a
  // still-valid older hint is safe if this pass has not reached that Chat yet.
  return candidate.sourceViewerChatGrantId ?? existing.sourceViewerChatGrantId;
}

/**
 * A CallSession is the canonical recording carrier. Preserve its exact source
 * pointer when a higher-ranked duplicate supplies the display metadata for the
 * same direct historical share; the source bridge still verifies the listed
 * file against that CallSession before returning any media URL.
 */
function directHistoryCallSessionContext(
  existing: DiscoveredVideoRecord,
  candidate: DiscoveredVideoRecord,
):
  | {
      sourceCallSessionId: string;
      sourceCallSessionVault: string;
      sourceRecordingVault?: string;
      sourceChatKind: 'direct' | 'group';
    }
  | undefined {
  if (
    existing.accessScope !== 'shared' ||
    candidate.accessScope !== 'shared' ||
    existing.accessBasis !== 'history' ||
    candidate.accessBasis !== 'history' ||
    !existing.sourceSpaceKey ||
    !candidate.sourceSpaceKey ||
    !sameEName(existing.sourceSpaceKey, candidate.sourceSpaceKey) ||
    !existing.sourceChatId ||
    existing.sourceChatId !== candidate.sourceChatId
  ) {
    return undefined;
  }
  const context = (item: DiscoveredVideoRecord) =>
    item.sourceCallSessionId && item.sourceCallSessionVault && item.sourceChatKind
      ? {
          sourceCallSessionId: item.sourceCallSessionId,
          sourceCallSessionVault: item.sourceCallSessionVault,
          ...(item.sourceRecordingVault ? { sourceRecordingVault: item.sourceRecordingVault } : {}),
          sourceChatKind: item.sourceChatKind,
        }
      : undefined;
  return context(candidate) ?? context(existing);
}

/** A GroupManifest pointer is valid only for a current group access context. */
function hasCompatibleGroupManifestContext(item: DiscoveredVideoRecord): boolean {
  return (
    item.accessScope === 'shared' &&
    Boolean(item.sourceSpaceKey) &&
    item.sourceChatKind === 'group' &&
    (item.accessBasis === 'membership' ||
      (item.accessBasis === 'history' && item.sourceChatKind === 'group'))
  );
}

/**
 * A duplicate may carry a fresher current GroupManifest pointer than the
 * display record. Keep it only when all available group contexts name the
 * same source space; a pointer must never cross a source boundary merely
 * because two cards resolve to the same canonical File.
 */
function compatibleGroupManifestPointer(
  selected: DiscoveredVideoRecord,
  existing: DiscoveredVideoRecord,
  candidate: DiscoveredVideoRecord,
): string | undefined {
  if (!hasCompatibleGroupManifestContext(selected) || !selected.sourceSpaceKey) return undefined;
  const pointers = [candidate, existing]
    .filter(
      (item) =>
        hasCompatibleGroupManifestContext(item) &&
        Boolean(item.sourceSpaceKey) &&
        Boolean(item.sourceGroupManifestId),
    )
    .filter((item) => sameEName(item.sourceSpaceKey ?? '', selected.sourceSpaceKey ?? ''));
  // If a record with a pointer was discovered through another group, do not
  // transfer either context across the file-identity merge.
  const allPointerContexts = [candidate, existing].filter(
    (item) => hasCompatibleGroupManifestContext(item) && Boolean(item.sourceGroupManifestId),
  );
  if (pointers.length !== allPointerContexts.length) return undefined;
  return pointers[0]?.sourceGroupManifestId;
}

/**
 * Strip a pointer before restoring the one compatible with the final merged
 * record. This matters when two different group bindings happen to name the
 * same canonical File: neither group's proof may silently win that merge.
 */
function withCompatibleGroupManifestPointer(
  selected: DiscoveredVideoRecord,
  existing: DiscoveredVideoRecord,
  candidate: DiscoveredVideoRecord,
): DiscoveredVideoRecord {
  const unpointed = { ...selected };
  delete unpointed.sourceGroupManifestId;
  const sourceGroupManifestId = compatibleGroupManifestPointer(selected, existing, candidate);
  return sourceGroupManifestId ? { ...unpointed, sourceGroupManifestId } : unpointed;
}

type ReferencePlaybackContext = Pick<
  DiscoveredVideoRecord,
  'sourceSpaceKey' | 'sourceReferenceId' | 'sourceReferenceFileId' | 'accessBasis'
>;

/**
 * `accessBasis: reference` is emitted only for a File reference discovered in
 * the viewer's own vault. It is a portable W3DS authorization artifact: the
 * private-media route re-reads that exact local reference before opening the
 * canonical File. Do not infer this context from a File URI or owner alone.
 *
 * Validate the stored target again here before transferring it to a richer
 * historical card. This keeps a malformed/stale reference from authorizing
 * an adjacent File with a similar presentation record.
 */
function viewerReferencePlaybackContext(
  item: DiscoveredVideoRecord,
): ReferencePlaybackContext | undefined {
  if (
    item.accessScope !== 'shared' ||
    item.accessBasis !== 'reference' ||
    !item.sourceSpaceKey ||
    !item.sourceReferenceId ||
    !item.sourceReferenceFileId ||
    item.fileUris.length !== 1
  ) {
    return undefined;
  }
  const target = parseW3dsFileUri(item.fileUris[0]);
  if (
    !target ||
    !sameEName(target.ownerEName, item.sourceSpaceKey) ||
    target.metaEnvelopeId !== item.sourceReferenceFileId
  ) {
    return undefined;
  }
  return {
    sourceSpaceKey: item.sourceSpaceKey,
    sourceReferenceId: item.sourceReferenceId,
    sourceReferenceFileId: item.sourceReferenceFileId,
    accessBasis: 'reference',
  };
}

/**
 * A direct viewer-vault File reference is stronger and more portable than a
 * legacy Chat/Call history pointer. When both discovery routes name the exact
 * same canonical File, keep the call/message presentation record while
 * preserving the reference as the playback proof. Group context is never
 * guessed or converted: only an already-validated local reference can take
 * this path, and a mismatched or generic owner File remains history-gated.
 */
function matchingReferencePlaybackContext(
  existing: DiscoveredVideoRecord,
  candidate: DiscoveredVideoRecord,
): ReferencePlaybackContext | undefined {
  const existingReference = viewerReferencePlaybackContext(existing);
  const candidateReference = viewerReferencePlaybackContext(candidate);
  if (Boolean(existingReference) === Boolean(candidateReference)) return undefined;

  const reference = existingReference ? existing : candidate;
  const history = existingReference ? candidate : existing;
  if (
    history.accessScope !== 'shared' ||
    history.accessBasis !== 'history' ||
    // A GroupManifest is mutable membership evidence. A local File reference
    // must not turn a known group recording into a portable direct share.
    history.sourceChatKind === 'group' ||
    videoSpaceFileIdentity(reference.fileUris) !== videoSpaceFileIdentity(history.fileUris)
  ) {
    return undefined;
  }
  return existingReference ?? candidateReference;
}

/**
 * A catalogue rescan can rediscover one CallSession with a richer ordered
 * source list than the retained checkpoint had. This happens when an old card
 * stored only `mediaUri` and a newer parser recognizes the whole
 * `mediaSegments` recording. Merge by its stable record key before file-URI
 * dedupe so the new list replaces the truncated one instead of becoming a
 * duplicate card beside it.
 */
function mergeRepeatedDiscoveryRecord(
  existing: DiscoveredVideoRecord,
  candidate: DiscoveredVideoRecord,
): DiscoveredVideoRecord {
  const viewerChatGrantId = directHistoryViewerChatGrantId(existing, candidate);
  const callSessionContext = directHistoryCallSessionContext(existing, candidate);
  const referencePlaybackContext = matchingReferencePlaybackContext(existing, candidate);
  const candidateHasMoreSources = candidate.fileUris.length > existing.fileUris.length;
  const existingHasUsefulTitle = hasUsefulTitle(existing);
  const candidateHasUsefulTitle = hasUsefulTitle(candidate);
  const selected =
    (existing.accessScope === 'shared' && candidate.accessScope === 'personal') ||
    candidateHasMoreSources ||
    (candidate.fileUris.length === existing.fileUris.length &&
      candidateHasUsefulTitle &&
      !existingHasUsefulTitle)
      ? candidate
      : existing;
  const merged = {
    ...selected,
    ...(viewerChatGrantId ? { sourceViewerChatGrantId: viewerChatGrantId } : {}),
    ...(callSessionContext ?? {}),
    ...(referencePlaybackContext ?? {}),
  };
  return withCompatibleGroupManifestPointer(merged, existing, candidate);
}

export function dedupeDiscoveredVideos(
  items: readonly DiscoveredVideoRecord[],
): DiscoveredVideoRecord[] {
  // First collapse equivalent source records. URI identity alone is not
  // stable across the legacy first-segment repair: one CallSession can grow
  // from `[part-1]` to `[part-1, part-2, …]` without becoming a new video.
  const byRecordKey = new Map<string, DiscoveredVideoRecord>();
  for (const candidate of items) {
    const existing = byRecordKey.get(candidate.key);
    byRecordKey.set(
      candidate.key,
      existing ? mergeRepeatedDiscoveryRecord(existing, candidate) : candidate,
    );
  }

  const unique = new Map<string, DiscoveredVideoRecord>();
  for (const item of byRecordKey.values()) {
    const identity = videoSpaceFileIdentity(item.fileUris);
    if (!identity) continue;
    const existing = unique.get(identity);
    if (!existing) {
      unique.set(identity, item);
      continue;
    }
    const viewerChatGrantId = directHistoryViewerChatGrantId(existing, item);
    const callSessionContext = directHistoryCallSessionContext(existing, item);
    const referencePlaybackContext = matchingReferencePlaybackContext(existing, item);
    // Keep a fresh direct-share proof when title/kind ranking selects the
    // retained record, and do not let a richer duplicate silently discard it.
    const retained =
      viewerChatGrantId && existing.sourceViewerChatGrantId !== viewerChatGrantId
        ? { ...existing, sourceViewerChatGrantId: viewerChatGrantId }
        : existing;
    const candidate =
      viewerChatGrantId && item.sourceViewerChatGrantId !== viewerChatGrantId
        ? { ...item, sourceViewerChatGrantId: viewerChatGrantId }
        : item;
    const existingHasUsefulTitle = hasUsefulTitle(retained);
    const nextHasUsefulTitle = hasUsefulTitle(candidate);
    const preferNext =
      (retained.accessScope === 'shared' && candidate.accessScope === 'personal') ||
      (retained.accessScope === candidate.accessScope &&
        (nextHasUsefulTitle !== existingHasUsefulTitle
          ? nextHasUsefulTitle
          : kindRank[candidate.kind] > kindRank[retained.kind]));
    const selected = preferNext ? candidate : retained;
    const selectedWithCallSession =
      callSessionContext &&
      (selected.sourceCallSessionId !== callSessionContext.sourceCallSessionId ||
        selected.sourceCallSessionVault !== callSessionContext.sourceCallSessionVault ||
        selected.sourceRecordingVault !== callSessionContext.sourceRecordingVault ||
        selected.sourceChatKind !== callSessionContext.sourceChatKind)
        ? { ...selected, ...callSessionContext }
        : selected;
    const merged = referencePlaybackContext
      ? { ...selectedWithCallSession, ...referencePlaybackContext }
      : selectedWithCallSession;
    unique.set(identity, withCompatibleGroupManifestPointer(merged, retained, candidate));
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
    // A File reference stored in the viewer's own eVault is an independent,
    // current authorization artifact. It must survive a same-URI Message that
    // was discovered first, so the later de-duplication step can retain the
    // richer card while promoting this stronger playback proof. References in
    // any other vault remain subject to normal URI de-duplication.
    const viewerOwnedReference = Boolean(reference && sameEName(vaultOwnerEName, viewerEName));
    const fileUri =
      reference?.fileUri ??
      optionalW3dsFileUri(file.parsed.uri) ??
      optionalW3dsFileUri(file.parsed.url) ??
      constructW3dsFileUri(vaultOwnerEName, file.id);
    if (
      !fileUri ||
      !parseW3dsFileUri(fileUri) ||
      (!viewerOwnedReference && referenced.has(fileUri))
    ) {
      continue;
    }
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
      // A File reference in the viewer's own vault is the authorization
      // artifact for this direct share. It is re-read before list/playback;
      // do not incorrectly require an unrelated group manifest from the
      // canonical owner's vault.
      sourceSpaceKey: reference?.ownerEName ?? vaultOwnerEName,
      ...(reference ? { sourceReferenceId: file.id } : {}),
      ...(reference ? { sourceReferenceFileId: reference.metaEnvelopeId } : {}),
      accessBasis:
        accessScope === 'personal' ? 'personal' : viewerOwnedReference ? 'reference' : 'membership',
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
  /** Viewer-vault current Chat grants keyed by canonical direct Chat id. */
  sourceViewerChatGrantIds?: ReadonlyMap<string, string>;
  /** Group membership needs its own current proof; only direct chats use the source grant bridge. */
  sourceChatKind?: 'direct' | 'group';
  /** Current group proof captured while indexing this exact group. */
  sourceGroupManifestId?: string;
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
    const sourceViewerChatGrantId = callChatId
      ? input.sourceViewerChatGrantIds?.get(callChatId)
      : undefined;
    const sourceRecordingVault = optionalEName(recording.recordingVault);
    // `resolveCall` attaches the vault that actually held the canonical
    // CallSession. That precise location must win over `recordingVault`: the
    // latter is a media-storage hint in the published schema and historical
    // direct recordings can keep their bytes on a different vault. Only an
    // older discovery record without canonical-location metadata falls back to
    // the recording vault, then the listing owner.
    const sourceCallSessionVault =
      optionalEName(call.sourceCallSessionVault) ?? sourceRecordingVault ?? input.sourceEName;
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
      ...(callChatId ? { sourceChatId: callChatId } : {}),
      ...(sourceViewerChatGrantId ? { sourceViewerChatGrantId } : {}),
      ...(call.id && sourceCallSessionVault
        ? {
            sourceCallSessionId: call.id,
            sourceCallSessionVault,
            ...(sourceRecordingVault ? { sourceRecordingVault } : {}),
          }
        : {}),
      ...(input.sourceChatKind ? { sourceChatKind: input.sourceChatKind } : {}),
      ...(accessScope === 'shared' &&
      input.sourceChatKind === 'group' &&
      input.sourceGroupManifestId
        ? { sourceGroupManifestId: input.sourceGroupManifestId }
        : {}),
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
  sourceChatIdHint?: string,
  sourceViewerChatGrantIdHint?: string,
  sourceViewerChatGrantIds?: ReadonlyMap<string, string>,
  sourceGroupManifestIdHint?: string,
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
    // The Messages-by-Chat endpoint already proves its chat context. Some
    // documented Message envelopes omit a duplicate `chatId` field, so retain
    // that trusted request context rather than turning a valid shared video
    // into an unprovable history card after persistence/revalidation.
    // A Messages-by-Chat response is scoped by the request's chat id. Prefer
    // that trusted context over a legacy payload alias: using the alias can
    // attach the card to a different direct grant and force playback back to
    // a slow broad Chat search.
    const sourceChatId = sourceChatIdHint ?? optionalString(message.parsed.chatId);
    const sourceViewerChatGrantId = sourceChatId
      ? sourceChatIdHint && sourceChatId === sourceChatIdHint
        ? (sourceViewerChatGrantIdHint ?? sourceViewerChatGrantIds?.get(sourceChatId))
        : sourceViewerChatGrantIds?.get(sourceChatId)
      : undefined;
    const accessScope = scopeForRecord({
      viewerEName,
      payload: message.parsed,
      fileUris,
      ...(sourceSpaceKey ? { vaultOwnerEName: sourceSpaceKey } : {}),
    });
    const sourceChatKind =
      accessScope === 'shared' && sourceSpaceKey && sourceGroupManifestIdHint
        ? ('group' as const)
        : undefined;
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
      ...(sourceChatId ? { sourceChatId } : {}),
      ...(sourceViewerChatGrantId ? { sourceViewerChatGrantId } : {}),
      ...(sourceChatKind ? { sourceChatKind } : {}),
      ...(sourceChatKind && sourceGroupManifestIdHint
        ? { sourceGroupManifestId: sourceGroupManifestIdHint }
        : {}),
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
  const uniqueSegments = [...new Set(segments)];
  const mediaUri = optionalString(recording.mediaUri);
  const validMediaUri = mediaUri && parseW3dsFileUri(mediaUri) ? mediaUri : undefined;

  // A modern recording can retain a real full-length file in `mediaUri` and
  // list generated fallback chunks separately. Prefer that file so native
  // range seeking remains available. Older recording writers, however, set
  // `mediaUri` to `mediaSegments[0]` for backwards compatibility; treating it
  // as a complete file silently dropped every later chunk and made an hour
  // call look like a ~20-minute video. In that legacy shape the ordered
  // segment list is the recording.
  if (validMediaUri && !uniqueSegments.includes(validMediaUri)) return [validMediaUri];
  return uniqueSegments;
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
