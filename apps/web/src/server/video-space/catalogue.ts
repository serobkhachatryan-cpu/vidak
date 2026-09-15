import type { DiscoveredVideoRecord, VideoAccessBasis, VideoSpaceKind } from './adapters';
import { dedupeDiscoveredVideos } from './adapters';
import type { InventoryCompleteness } from './completeness';
import { documentedVideoSourceIds, documentedVideoSources } from './documented-sources';
import { privateLibraryDisplayTitle } from './titles';
import {
  type VideoSpaceAccessScope,
  type VideoSpaceVisibility,
  visibilityForEVaultVideo,
} from './visibility';

/**
 * Normalized catalogue card. Source adapters (W3DS File, File records,
 * call recordings, video messages) collapse into this shape before UI.
 */
export interface VideoSpaceCatalogueItem {
  id: string;
  kind: VideoSpaceKind;
  title: string;
  durationSeconds?: number;
  shape?: string;
  createdAt?: string;
  accessScope: VideoSpaceAccessScope;
  visibility: VideoSpaceVisibility;
  streamIds: string[];
  /**
   * Server-only HMAC for retiring a confirmed stale shared card. It is never
   * included in browser JSON or used as a playback authorization grant.
   */
  sharedCardBindingHash?: string;
  sourceSpaceKey?: string;
  sourceChatId?: string;
  /** Server-only current viewer Chat evidence for a direct historical share. */
  sourceViewerChatGrantId?: string;
  /** Server-only proof for a File reference stored in the viewer's vault. */
  sourceReferenceId?: string;
  sourceReferenceFileId?: string;
  accessBasis?: VideoAccessBasis;
}

export interface VideoSpaceCatalogueSnapshot {
  items: VideoSpaceCatalogueItem[];
  completeness: InventoryCompleteness;
}

export interface VideoSpaceStreamGrantInput {
  /** Server-only card binding HMAC, copied into every sealed recording segment. */
  sharedCardBindingHash?: string;
  fileUri: string;
  accessScope: VideoSpaceAccessScope;
  sourceSpaceKey?: string;
  /**
   * Current GroupManifest envelope verified during private inventory. This is
   * copied only into the sealed stream grant; catalogue JSON never exposes
   * it to the browser.
   */
  sourceGroupManifestId?: string;
  sourceChatId?: string;
  sourceViewerChatGrantId?: string;
  sourceCallSessionId?: string;
  sourceCallSessionVault?: string;
  sourceRecordingVault?: string;
  sourceChatKind?: 'direct' | 'group';
  sourceReferenceId?: string;
  sourceReferenceFileId?: string;
  accessBasis?: VideoAccessBasis;
}

function canIssueViewerStream(item: DiscoveredVideoRecord): boolean {
  if (item.accessScope === 'personal') return true;
  if (!item.sourceSpaceKey) return false;
  return (
    item.accessBasis === 'personal' ||
    item.accessBasis === 'membership' ||
    (item.accessBasis === 'reference' &&
      Boolean(item.sourceReferenceId) &&
      Boolean(item.sourceReferenceFileId)) ||
    Boolean(item.sourceChatId)
  );
}

/**
 * Deduplicate, assign viewer-facing visibility, and keep whatever was indexed
 * even when a shared space is incomplete. A failed group must never wipe the
 * rest of the inventory.
 */
export function assembleVideoSpaceCatalogue(input: {
  records: readonly DiscoveredVideoRecord[];
  completeness: InventoryCompleteness;
  viewerEName: string;
  toStreamId: (input: VideoSpaceStreamGrantInput) => string;
  /**
   * Creates an opaque binding from the stable source context while source
   * fields are still server-only. No source data is returned from this API.
   */
  toSharedCardBindingHash?: (item: DiscoveredVideoRecord) => string | undefined;
}): VideoSpaceCatalogueSnapshot {
  const unique = dedupeDiscoveredVideos(input.records);
  return {
    items: unique
      .map((item) => {
        const sharedCardBindingHash =
          item.accessScope === 'shared' ? input.toSharedCardBindingHash?.(item) : undefined;
        return {
          id: item.key,
          kind: item.kind,
          title: privateLibraryDisplayTitle(item.title, item.accessScope),
          ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
          ...(item.shape ? { shape: item.shape } : {}),
          ...(item.createdAt ? { createdAt: item.createdAt } : {}),
          accessScope: item.accessScope,
          visibility: visibilityForEVaultVideo({
            accessScope: item.accessScope,
            viewerEName: input.viewerEName,
          }),
          // Stream grants are viewer-bound. Shared grants retain only opaque,
          // server-side source context so their authorization can be checked on
          // every media request before the foreign File is opened.
          streamIds: canIssueViewerStream(item)
            ? item.fileUris.map((fileUri) =>
                input.toStreamId({
                  ...(sharedCardBindingHash ? { sharedCardBindingHash } : {}),
                  fileUri,
                  accessScope: item.accessScope,
                  ...(item.sourceSpaceKey ? { sourceSpaceKey: item.sourceSpaceKey } : {}),
                  ...(item.sourceGroupManifestId
                    ? { sourceGroupManifestId: item.sourceGroupManifestId }
                    : {}),
                  ...(item.sourceChatId ? { sourceChatId: item.sourceChatId } : {}),
                  ...(item.sourceViewerChatGrantId
                    ? { sourceViewerChatGrantId: item.sourceViewerChatGrantId }
                    : {}),
                  ...(item.sourceCallSessionId
                    ? { sourceCallSessionId: item.sourceCallSessionId }
                    : {}),
                  ...(item.sourceCallSessionVault
                    ? { sourceCallSessionVault: item.sourceCallSessionVault }
                    : {}),
                  ...(item.sourceRecordingVault
                    ? { sourceRecordingVault: item.sourceRecordingVault }
                    : {}),
                  ...(item.sourceChatKind ? { sourceChatKind: item.sourceChatKind } : {}),
                  ...(item.sourceReferenceId ? { sourceReferenceId: item.sourceReferenceId } : {}),
                  ...(item.sourceReferenceFileId
                    ? { sourceReferenceFileId: item.sourceReferenceFileId }
                    : {}),
                  ...(item.accessBasis ? { accessBasis: item.accessBasis } : {}),
                }),
              )
            : [],
          ...(item.sourceSpaceKey ? { sourceSpaceKey: item.sourceSpaceKey } : {}),
          ...(item.sourceChatId ? { sourceChatId: item.sourceChatId } : {}),
          ...(item.sourceViewerChatGrantId
            ? { sourceViewerChatGrantId: item.sourceViewerChatGrantId }
            : {}),
          ...(item.sourceReferenceId ? { sourceReferenceId: item.sourceReferenceId } : {}),
          ...(item.sourceReferenceFileId
            ? { sourceReferenceFileId: item.sourceReferenceFileId }
            : {}),
          ...(item.accessBasis ? { accessBasis: item.accessBasis } : {}),
          ...(sharedCardBindingHash ? { sharedCardBindingHash } : {}),
        };
      })
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    completeness: input.completeness,
  };
}

export const videoSpaceSourceAdapters = documentedVideoSources;
export const videoSpaceSourceIds = documentedVideoSourceIds;
