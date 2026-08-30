import type { Video } from '@w3ds/types';
import {
  type VideoSpaceVisibility,
  videoSpaceVisibilityLabels,
  visibilityForOwnedVidakVideo,
} from '../../server/video-space/visibility';

export type VideoSpaceTab = 'yours' | 'shared' | 'explore';

export interface VideoSpaceLibraryItem {
  id: string;
  title: string;
  accessScope: 'personal' | 'shared';
  visibility: VideoSpaceVisibility;
  kind?: 'call-recording' | 'video-message' | 'file';
  durationSeconds?: number;
  createdAt?: string;
  streamIds?: string[];
}

export { videoSpaceVisibilityLabels } from '../../server/video-space/visibility';

export const videoSpaceTabs: ReadonlyArray<{ id: VideoSpaceTab; label: string }> = [
  { id: 'yours', label: 'Your videos' },
  { id: 'shared', label: 'Shared with you' },
  { id: 'explore', label: 'Explore public videos' },
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

export function previewFallbackCopy(state: 'processing' | 'unsupported'): {
  label: string;
  description: string;
} {
  if (state === 'processing') {
    return {
      label: 'Preview is being prepared',
      description: 'This video is available. A still frame will appear when the file can be read.',
    };
  }
  return {
    label: 'Preview unavailable',
    description: 'This video can still be opened. A still frame could not be created from the file.',
  };
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
