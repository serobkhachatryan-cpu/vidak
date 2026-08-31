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
  if (type === 'resolve-media' && typeof record.vaultKey === 'string') return record.vaultKey;
  return ownVaultKey;
}

export function inventoryTaskKey(item: object, vaultKey: string): string {
  const record = item as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const after = typeof record.after === 'string' || record.after === null ? record.after : null;
  const ontologyId = typeof record.ontologyId === 'string' ? record.ontologyId : '';
  const chatId = typeof record.chatId === 'string' ? record.chatId : '';
  const fileUri = typeof record.fileUri === 'string' ? record.fileUri : '';
  return [type, vaultKey, ontologyId, chatId, after ?? '', fileUri].join('\u0000');
}

export type InventoryWork = DeferredWork & { type: string };
