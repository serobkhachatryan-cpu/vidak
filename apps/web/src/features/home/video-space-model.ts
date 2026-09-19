import { isRenderableThumbnailUrl, type Video } from '@w3ds/types';
import {
  completeInventory,
  coveragePageTotal,
  type InventoryCompleteness,
  inventoryCompletenessCopy,
} from '../../server/video-space/completeness';
import type { InventoryDiscovery } from '../../server/video-space/discovery';
import {
  type VideoSpaceVisibility,
  videoSpaceVisibilityLabels,
  visibilityForOwnedVidakVideo,
} from '../../server/video-space/visibility';

export type VideoSpaceTab = 'all' | 'yours' | 'shared' | 'explore';

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
  /** Safe high-level source context for a shared card. */
  sharedVia?: 'group' | 'conversation';
  /** An explicitly chosen public Vidak name for a verified direct share. */
  sharedBy?: string;
  /** The card stays visible while Vidak retries a transient shared-source check. */
  sourceAccess?: 'checking';
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
  { id: 'all', label: 'All accessible' },
  { id: 'yours', label: 'My videos' },
  { id: 'shared', label: 'Shared with me' },
  { id: 'explore', label: 'Public catalogue' },
];

export const videoSpaceEmptyCopy = {
  title: 'Your video space is ready',
  description:
    'Vidak is a viewer and sharing layer over your W3DS space. It shows video you already own or are authorized to view — including files created in other apps — without importing from a specific app first.',
};

/** Product copy deliberately describes the W3DS space, not a source app. */
export const videoSpacePanelCopy = {
  all: 'Your videos and videos shared with you are shown in separate groups, so each card makes its access and available actions clear.',
  mine: 'Every video you own in your W3DS space, including videos created in other W3DS apps. Finding them never changes their sharing rules.',
  shared:
    'Videos other people own that you are currently authorized to view. Finding them never changes their sharing rules.',
  emptyMine: 'Videos you own in your W3DS space appear here.',
  emptyShared:
    'When someone authorizes you to view a video in their W3DS space, it will appear here.',
  emptyAll:
    'Videos you own or are authorized to view will appear here. The Public catalogue contains Vidak-published videos.',
} as const;

/** Plain-language orientation for the private W3DS library. */
export const videoSpaceGuideCopy = {
  title: 'How this library works',
  summary: 'Every card explains why it is here and what you can do with it.',
  points: [
    'My videos contains videos you own in your private W3DS space. You can prepare their audience before or after editing. Videos from another W3DS app stay managed by that app.',
    'Shared with me contains view-only videos whose owner has authorized you. Watching never changes their privacy or sharing rules.',
    'Vidak synchronizes this library automatically. Refresh checks for updates right away; it does not upload, copy, or change your original videos.',
  ],
} as const;

export type VideoSpaceCardActionId = 'continue-editing' | 'watch' | 'manage-access';

export interface VideoSpaceCardAction {
  id: VideoSpaceCardActionId;
  label: string;
  description: string;
}

/**
 * The user-facing contract for a card.  Rendering code must derive its
 * primary action from this model rather than from which app discovered the
 * video.  That prevents a shared card from ever looking like an owner card.
 */
export interface VideoSpaceCardPresentation {
  kind:
    | 'owned-draft'
    | 'owned-playable'
    | 'owned-manage-access'
    | 'personal-playable'
    | 'personal-unavailable'
    | 'shared-playable'
    | 'shared-checking'
    | 'shared-unavailable';
  relationshipLabel: string;
  relationshipDescription: string;
  primaryAction?: VideoSpaceCardAction;
  secondaryAction?: VideoSpaceCardAction;
  unavailable?: {
    label: string;
    description: string;
  };
}

export function canWatchOwnedVidakVideo(
  video: Pick<Video, 'status' | 'publicVideoId' | 'visibility'>,
): boolean {
  return (
    video.status === 'published' &&
    Boolean(video.publicVideoId) &&
    (video.visibility === 'public' || video.visibility === 'unlisted')
  );
}

export function ownedVideoCardPresentation(
  video: Pick<Video, 'status' | 'publicVideoId' | 'visibility'>,
): VideoSpaceCardPresentation {
  if (video.status === 'draft') {
    return {
      kind: 'owned-draft',
      relationshipLabel: 'You own this draft',
      relationshipDescription: 'Finish editing now, or prepare its audience for publication.',
      primaryAction: {
        id: 'continue-editing',
        label: 'Continue editing',
        description: 'Open this draft in the Vidak editor.',
      },
      secondaryAction: {
        id: 'manage-access',
        label: 'Manage access',
        description: 'Prepare who can watch after this draft is published.',
      },
    };
  }

  if (canWatchOwnedVidakVideo(video)) {
    const isLinkOnly = video.visibility === 'unlisted';
    return {
      kind: 'owned-playable',
      relationshipLabel: 'You own this Vidak video',
      relationshipDescription: isLinkOnly
        ? 'Anyone with the link can watch it. It is not listed in the public catalogue.'
        : 'You can watch it and choose who can access it.',
      primaryAction: {
        id: 'watch',
        label: 'Watch video',
        description: 'Open the video player.',
      },
      secondaryAction: {
        id: 'manage-access',
        label: 'Manage access',
        description: 'Choose who can watch this video.',
      },
    };
  }

  return {
    kind: 'owned-manage-access',
    relationshipLabel: 'You own this Vidak video',
    relationshipDescription:
      'It is not in the public catalogue. Manage access to review who can watch it or share it with specific people.',
    primaryAction: {
      id: 'manage-access',
      label: 'Manage access',
      description: 'Choose who can watch this video.',
    },
  };
}

export function libraryVideoCardPresentation(
  video: Pick<
    VideoSpaceLibraryItem,
    'accessScope' | 'kind' | 'visibility' | 'sharedVia' | 'sharedBy' | 'sourceAccess' | 'streamIds'
  >,
): VideoSpaceCardPresentation {
  const playable = canPlayLibraryVideo(video);
  const source = librarySourceLabel(video);

  if (video.accessScope === 'shared' || video.visibility === 'shared-with-me') {
    if (playable) {
      return {
        kind: 'shared-playable',
        relationshipLabel: video.sharedBy ? `Shared by ${video.sharedBy}` : 'Shared with you',
        relationshipDescription: `${source}. View only — only the owner can change access.`,
        primaryAction: {
          id: 'watch',
          label: 'Watch video',
          description: 'Open this shared video.',
        },
      };
    }
    if (video.sourceAccess === 'checking') {
      return {
        kind: 'shared-checking',
        relationshipLabel: video.sharedBy ? `Shared by ${video.sharedBy}` : 'Shared with you',
        relationshipDescription: `${source}. View only — only the owner can change access.`,
        unavailable: {
          label: 'Checking access',
          description: 'Vidak is confirming that the owner still authorizes playback.',
        },
      };
    }
    return {
      kind: 'shared-unavailable',
      relationshipLabel: video.sharedBy ? `Shared by ${video.sharedBy}` : 'Shared with you',
      relationshipDescription: `${source}. View only — only the owner can change access.`,
      unavailable: {
        label: 'Playback unavailable',
        description: 'The source does not currently provide a playable video for your account.',
      },
    };
  }

  if (playable) {
    return {
      kind: 'personal-playable',
      relationshipLabel: 'Your W3DS video',
      relationshipDescription: `${source}. Its sharing policy stays managed by the app that created it.`,
      primaryAction: {
        id: 'watch',
        label: 'Watch video',
        description: 'Open this video from your W3DS space.',
      },
    };
  }

  return {
    kind: 'personal-unavailable',
    relationshipLabel: 'Your W3DS video',
    relationshipDescription: `${source}. Its sharing policy stays managed by the app that created it.`,
    unavailable: {
      label: 'Playback unavailable',
      description: 'The source does not currently provide a playable video.',
    },
  };
}

export function evaultItemsForTab(
  items: readonly VideoSpaceLibraryItem[],
  tab: VideoSpaceTab,
): VideoSpaceLibraryItem[] {
  if (tab === 'explore') return [];
  if (tab === 'shared') return items.filter((item) => item.accessScope === 'shared');
  if (tab === 'yours') return items.filter((item) => item.accessScope === 'personal');
  return [...items];
}

export function ownedItemsForTab(items: readonly Video[], tab: VideoSpaceTab): Video[] {
  if (tab === 'shared' || tab === 'explore') return [];
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
    (completeness.deferred ?? 0) === 0 &&
    (completeness.retrying ?? 0) === 0 &&
    completeness.denied === 0 &&
    completeness.missing === 0
  ) {
    return undefined;
  }
  if ((completeness.deferred ?? 0) > 0 || (completeness.retrying ?? 0) > 0) {
    return inventoryCompletenessCopy(completeness);
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
  const deferred = completeness?.deferred ?? 0;
  if (retrying > 0) parts.push(`retrying ${retrying}`);
  else if (deferred > 0) parts.push('still synchronizing — will continue automatically');
  else if (input.discovery === 'partial' && completeness?.retryNeeded) parts.push('retry needed');
  else if (input.discovery === 'refreshing')
    parts.push('still synchronizing — will continue automatically');
  const coverage = completeness?.coverage;
  if (coverage) {
    if (coverage.groupHistories > 0) parts.push(`${coverage.groupHistories} histories`);
    if (coverage.directChats > 0) parts.push(`${coverage.directChats} directs`);
    const pages = coveragePageTotal(coverage);
    if (pages > 0) parts.push(`${pages} pages scanned`);
  }
  const media = completeness?.media;
  if (media && (media.candidates > 0 || media.accepted > 0 || media.excludedNonVideo > 0)) {
    parts.push(`${media.candidates} media records`);
    parts.push(`${media.accepted} playable`);
    if (media.excludedNonVideo > 0) parts.push(`${media.excludedNonVideo} non-video`);
    const unresolvedParts = Object.entries(media.unresolved)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${count} ${reason}`);
    if (unresolvedParts.length) parts.push(`unresolved ${unresolvedParts.join(', ')}`);
  }
  return parts.join(' · ');
}

export function libraryDiscoveryBanner(input: {
  discovery?: InventoryDiscovery;
  completeness?: InventoryCompleteness;
  itemCount: number;
  shared?: boolean;
}): string | undefined {
  const deferred = input.completeness?.deferred ?? 0;
  const retrying = input.completeness?.retrying ?? 0;
  if (
    input.discovery === 'refreshing' ||
    input.discovery === 'partial' ||
    deferred > 0 ||
    retrying > 0
  ) {
    return libraryProgressCopy({
      itemCount: input.itemCount,
      shared: input.shared === true,
      ...(input.discovery ? { discovery: input.discovery } : {}),
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
    label: 'Video ready to watch',
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

export function librarySourceLabel(
  video: Pick<
    VideoSpaceLibraryItem,
    'accessScope' | 'kind' | 'visibility' | 'sharedVia' | 'sharedBy'
  >,
): string {
  if (video.accessScope === 'shared' || video.visibility === 'shared-with-me') {
    if (video.sharedBy) return `Shared by ${video.sharedBy} through a W3DS conversation`;
    return video.sharedVia === 'group'
      ? 'Shared with you through a W3DS group'
      : 'Shared with you through a W3DS conversation';
  }
  if (video.kind === 'call-recording') return 'Your call recording';
  if (video.kind === 'video-message') return 'Your video message';
  return 'Your video';
}

export function libraryCardDetails(
  video: Pick<
    VideoSpaceLibraryItem,
    | 'durationSeconds'
    | 'createdAt'
    | 'accessScope'
    | 'kind'
    | 'visibility'
    | 'sharedVia'
    | 'sharedBy'
  >,
): string {
  const values = [
    video.durationSeconds !== undefined ? formatSpaceDuration(video.durationSeconds) : undefined,
    video.createdAt ? new Date(video.createdAt).toLocaleDateString() : undefined,
  ].filter(Boolean);
  return values.join(' · ');
}

export function canPlayLibraryVideo(
  video: Pick<VideoSpaceLibraryItem, 'accessScope' | 'streamIds'>,
): boolean {
  return Boolean(video.streamIds?.length);
}

/**
 * A same-origin owned-preview path is an asynchronous capture endpoint, not a
 * completed thumbnail. Preserve that distinction so an ordinary 202/422 does
 * not render as a broken preview on a draft card.
 */
export function ownedVideoPoster(input: Pick<Video, 'id' | 'thumbnailUrl' | 'status'>): {
  generatedPoster: string;
  existingPoster?: string;
  state: 'ready' | 'processing';
} {
  const generatedPoster = `/api/videos/owned/${encodeURIComponent(input.id)}/preview`;
  const existingPoster =
    input.thumbnailUrl !== generatedPoster && isRenderableThumbnailUrl(input.thumbnailUrl)
      ? input.thumbnailUrl
      : undefined;
  return {
    generatedPoster,
    ...(existingPoster ? { existingPoster } : {}),
    state: input.status === 'processing' || !existingPoster ? 'processing' : 'ready',
  };
}

export function ownedVideoSpaceVisibility(video: Pick<Video, 'status' | 'visibility'>): {
  id: VideoSpaceVisibility;
  label: string;
} {
  const id = visibilityForOwnedVidakVideo(video);
  return { id, label: videoSpaceVisibilityLabels[id] };
}
