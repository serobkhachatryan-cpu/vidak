import type { Video } from '@w3ds/types';
import {
  completeInventory,
  type InventoryCompleteness,
  inventoryCompletenessCopy,
} from '../../server/video-space/completeness';
import type { InventoryDiscovery } from '../../server/video-space/discovery';
import {
  type VideoSpaceVisibility,
  videoSpaceVisibilityLabels,
  visibilityForOwnedVidakVideo,
} from '../../server/video-space/visibility';

export type VideoSpaceTab = 'yours' | 'shared' | 'explore';

export type VideoSpacePreviewState = 'ready' | 'processing' | 'unavailable';

export interface VideoSpaceLibraryItem {
  id: string;
  title: string;
  accessScope: 'personal' | 'shared';
  visibility: VideoSpaceVisibility;
  kind?: 'call-recording' | 'video-message' | 'file';
  durationSeconds?: number;
  createdAt?: string;
  streamIds?: string[];
  previewState?: VideoSpacePreviewState;
  previewUrl?: string;
}

export {
  type InventoryCompleteness,
  inventoryCompletenessCopy,
} from '../../server/video-space/completeness';
export type { InventoryDiscovery } from '../../server/video-space/discovery';
export { videoSpaceVisibilityLabels } from '../../server/video-space/visibility';
export { completeInventory };

export const videoSpaceTabs: ReadonlyArray<{ id: VideoSpaceTab; label: string }> = [
  { id: 'yours', label: 'Your videos' },
  { id: 'shared', label: 'Shared with you' },
  { id: 'explore', label: 'Public videos published in Vidak' },
];

export const videoSpaceEmptyCopy = {
  title: 'Your video space is ready',
  description:
    'Vidak is a viewer and sharing layer over your W3DS space. It shows video you already own or are authorized to view — including files created in other apps — without importing from a specific app first.',
};

export function evaultItemsForTab(
  items: readonly VideoSpaceLibraryItem[],
  tab: VideoSpaceTab,
): VideoSpaceLibraryItem[] {
  if (tab === 'explore') return [];
  if (tab === 'shared') return items.filter((item) => item.accessScope === 'shared');
  return items.filter((item) => item.accessScope === 'personal');
}

export function ownedItemsForTab(items: readonly Video[], tab: VideoSpaceTab): Video[] {
  if (tab !== 'yours') return [];
  return [...items];
}

export function isVideoSpaceEmpty(
  libraryItems: readonly VideoSpaceLibraryItem[],
  ownedItems: readonly Video[],
): boolean {
  return libraryItems.length === 0 && ownedItems.length === 0;
}

export function sharedInventoryBanner(
  completeness: InventoryCompleteness | undefined,
): string | undefined {
  if (!completeness) return undefined;
  if (
    completeness.complete &&
    !completeness.retryNeeded &&
    completeness.denied === 0 &&
    completeness.missing === 0
  ) {
    return undefined;
  }
  return inventoryCompletenessCopy(completeness);
}

export function libraryUpdatingCopy(count: number): string {
  return `Showing ${count} ${count === 1 ? 'video' : 'videos'} — updating your library…`;
}

export function libraryProgressCopy(input: {
  itemCount: number;
  shared: boolean;
  completeness?: InventoryCompleteness;
  discovery?: InventoryDiscovery;
}): string {
  const noun = input.shared ? 'shared videos' : 'videos';
  const found = `${input.itemCount} ${noun} found`;
  const completeness = input.completeness;
  const parts = [found];
  if (completeness && completeness.expected > 0) {
    parts.push(`${completeness.indexed} of ${completeness.expected} spaces indexed`);
  }
  const retrying = completeness?.retrying ?? 0;
  if (retrying > 0) parts.push(`retrying ${retrying}`);
  else if (input.discovery === 'partial' && completeness?.retryNeeded) parts.push('retry needed');
  else if (input.discovery === 'refreshing') parts.push('updating your library');
  return parts.join(' · ');
}

export function libraryDiscoveryBanner(input: {
  discovery?: InventoryDiscovery;
  completeness?: InventoryCompleteness;
  itemCount: number;
  shared?: boolean;
}): string | undefined {
  if (input.discovery === 'refreshing' || input.discovery === 'partial') {
    return libraryProgressCopy({
      itemCount: input.itemCount,
      shared: input.shared === true,
      discovery: input.discovery,
      ...(input.completeness ? { completeness: input.completeness } : {}),
    });
  }
  return undefined;
}

export function previewFallbackCopy(state: 'processing' | 'unavailable' | 'unsupported'): {
  label: string;
  description: string;
} {
  if (state === 'processing') {
    return {
      label: 'Preparing preview',
      description: '',
    };
  }
  return {
    label: 'Preview unavailable',
    description: '',
  };
}

export function formatSpaceDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function shareChangeConfirmation(next: VideoSpaceVisibility): string {
  return `This changes only this video’s visibility to ${videoSpaceVisibilityLabels[next]}. Continue?`;
}

export function ownedVideoSpaceVisibility(video: Pick<Video, 'status' | 'visibility'>): {
  id: VideoSpaceVisibility;
  label: string;
} {
  const id = visibilityForOwnedVidakVideo(video);
  return { id, label: videoSpaceVisibilityLabels[id] };
}
