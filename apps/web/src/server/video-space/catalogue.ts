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
  sourceSpaceKey?: string;
  sourceChatId?: string;
  accessBasis?: VideoAccessBasis;
}

export interface VideoSpaceCatalogueSnapshot {
  items: VideoSpaceCatalogueItem[];
  completeness: InventoryCompleteness;
}

export interface VideoSpaceStreamGrantInput {
  fileUri: string;
  accessScope: VideoSpaceAccessScope;
  sourceSpaceKey?: string;
  sourceChatId?: string;
  accessBasis?: VideoAccessBasis;
}

function canIssueViewerStream(item: DiscoveredVideoRecord): boolean {
  if (item.accessScope === 'personal') return true;
  if (!item.sourceSpaceKey) return false;
  return (
    item.accessBasis === 'personal' ||
    item.accessBasis === 'membership' ||
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
}): VideoSpaceCatalogueSnapshot {
  const unique = dedupeDiscoveredVideos(input.records);
  return {
    items: unique
      .map((item) => ({
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
                fileUri,
                accessScope: item.accessScope,
                ...(item.sourceSpaceKey ? { sourceSpaceKey: item.sourceSpaceKey } : {}),
                ...(item.sourceChatId ? { sourceChatId: item.sourceChatId } : {}),
                ...(item.accessBasis ? { accessBasis: item.accessBasis } : {}),
              }),
            )
          : [],
        ...(item.sourceSpaceKey ? { sourceSpaceKey: item.sourceSpaceKey } : {}),
        ...(item.sourceChatId ? { sourceChatId: item.sourceChatId } : {}),
        ...(item.accessBasis ? { accessBasis: item.accessBasis } : {}),
      }))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    completeness: input.completeness,
  };
}

export const videoSpaceSourceAdapters = documentedVideoSources;
export const videoSpaceSourceIds = documentedVideoSourceIds;
