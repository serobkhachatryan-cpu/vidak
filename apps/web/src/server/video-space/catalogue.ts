import type { DiscoveredVideoRecord, VideoAccessBasis, VideoSpaceKind } from './adapters';
import { dedupeDiscoveredVideos } from './adapters';
import type { InventoryCompleteness } from './completeness';
import { documentedVideoSourceIds, documentedVideoSources } from './documented-sources';
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
  accessBasis?: VideoAccessBasis;
}

export interface VideoSpaceCatalogueSnapshot {
  items: VideoSpaceCatalogueItem[];
  completeness: InventoryCompleteness;
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
  toStreamId: (fileUri: string) => string;
}): VideoSpaceCatalogueSnapshot {
  const unique = dedupeDiscoveredVideos(input.records);
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
          viewerEName: input.viewerEName,
        }),
        streamIds: item.fileUris.map((fileUri) => input.toStreamId(fileUri)),
        ...(item.sourceSpaceKey ? { sourceSpaceKey: item.sourceSpaceKey } : {}),
        ...(item.accessBasis ? { accessBasis: item.accessBasis } : {}),
      }))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    completeness: input.completeness,
  };
}

export const videoSpaceSourceAdapters = documentedVideoSources;
export const videoSpaceSourceIds = documentedVideoSourceIds;
