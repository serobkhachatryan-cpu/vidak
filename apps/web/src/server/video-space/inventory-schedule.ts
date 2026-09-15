import type { DeferredWork } from './work-queue';

export function inventoryWorkPriority(kind: string): number {
  switch (kind) {
    case 'group-open':
    case 'direct-open':
      return 10;
    case 'group-manifests':
      return 20;
    case 'chats':
    case 'group-chats':
    case 'direct-chats':
      return 30;
    case 'owned-source':
      return 35;
    case 'group-files':
    case 'group-calls':
    case 'direct-calls':
      return 40;
    case 'resolve-media':
      return 45;
    // A CallSession card is already visible, so warm its first canonical
    // eVault source immediately after opening the source space. This runs
    // ahead of resumable history/detail scans; its own sealed grant still
    // performs the current group/direct access proof before any URL is used.
    // The player continues to own the full ordered segment list.
    case 'prewarm-call-media':
      return 15;
    case 'group-history':
    case 'direct-history':
      return 50;
    case 'messages':
    case 'group-messages':
    case 'direct-messages':
      return 60;
    case 'author-messages':
      return 70;
    default:
      return 80;
  }
}

export function inventoryVaultKey(item: object, ownVaultKey: string): string {
  const record = item as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (typeof record.owner === 'string' && record.owner) return record.owner;
  if (type === 'author-messages' && typeof record.authorEName === 'string') {
    return record.authorEName;
  }
  if (type === 'group-open' && typeof record.groupEName === 'string') return record.groupEName;
  if (type === 'direct-open' && typeof record.ownerEName === 'string') return record.ownerEName;
  if (
    typeof record.ownerEName === 'string' &&
    type !== 'chats' &&
    type !== 'messages' &&
    type !== 'owned-source'
  ) {
    return record.ownerEName;
  }
  if (
    (type === 'resolve-media' || type === 'prewarm-call-media') &&
    typeof record.vaultKey === 'string'
  ) {
    return record.vaultKey;
  }
  return ownVaultKey;
}

/** Unit separator: Postgres text rejects NUL (`\\u0000`) bytes. */
const taskKeySeparator = '\u001f';

function taskKeySegment(value: string): string {
  return value.replaceAll('\u0000', '').replaceAll(taskKeySeparator, ' ');
}

function optionalTaskKeyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A File can be shared through several conversations. Prewarming one source
 * context must not dedupe away another because the server-only media URL cache
 * is bound to the exact viewer/source authorization context, not File alone.
 */
function prewarmAuthorizationContext(record: Record<string, unknown>): string {
  const sourceMetadata =
    record.sourceMetadata && typeof record.sourceMetadata === 'object'
      ? (record.sourceMetadata as Record<string, unknown>)
      : {};
  const streamGrant =
    record.streamGrant && typeof record.streamGrant === 'object'
      ? (record.streamGrant as Record<string, unknown>)
      : {};
  const field = (name: string): string =>
    optionalTaskKeyString(record[name]) ||
    optionalTaskKeyString(sourceMetadata[name]) ||
    optionalTaskKeyString(streamGrant[name]);
  return [
    field('sourceSpaceKey'),
    field('sourceId'),
    field('accessScope'),
    field('accessBasis'),
    field('sourceChatKind'),
    field('sourceGroupManifestId'),
    field('chatId'),
    field('sourceViewerChatGrantId'),
    field('sourceCallSessionVault'),
    field('sourceCallSessionId'),
    field('sourceRecordingVault'),
    field('sourceReferenceId'),
    field('sourceReferenceFileId'),
  ]
    .map(taskKeySegment)
    .join(taskKeySeparator);
}

export function inventoryTaskKey(item: object, vaultKey: string): string {
  const record = item as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const after = typeof record.after === 'string' || record.after === null ? record.after : null;
  const ontologyId = typeof record.ontologyId === 'string' ? record.ontologyId : '';
  const chatId = typeof record.chatId === 'string' ? record.chatId : '';
  const fileUri = typeof record.fileUri === 'string' ? record.fileUri : '';
  const envelopeId = typeof record.envelopeId === 'string' ? record.envelopeId : '';
  // A cache-warming read is optional work; it must not replace the same
  // authoritative resolver task (or vice versa) when both target one File.
  // Preserve legacy task keys for ordinary resolver work so an in-flight
  // durable queue resumes unchanged after deployment.
  const prewarm = record.mode === 'prewarm' || type === 'prewarm-call-media';
  const mediaKey = prewarm ? `prewarm:${fileUri || envelopeId}` : fileUri || envelopeId;
  const parts = [type, vaultKey, ontologyId, chatId, after ?? '', mediaKey];
  if (prewarm) parts.push(prewarmAuthorizationContext(record));
  return parts.map((part) => taskKeySegment(String(part))).join(taskKeySeparator);
}

export type InventoryWork = DeferredWork & { type: string };
