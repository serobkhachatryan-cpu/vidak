import type { VideoId } from '@w3ds/types';

/**
 * Same-origin path for authenticated draft media content.
 * Requires the creator session cookie; not a public playback URL.
 */
export function draftMediaContentPath(videoId: VideoId, assetId: string): string {
  return `/api/videos/drafts/${encodeURIComponent(videoId)}/media/${encodeURIComponent(assetId)}/content`;
}

/** Same-origin path for owned draft media metadata. */
export function draftMediaAssetPath(videoId: VideoId, assetId: string): string {
  return `/api/videos/drafts/${encodeURIComponent(videoId)}/media/${encodeURIComponent(assetId)}`;
}

/** Same-origin path for uploading media into an owned draft. */
export function draftMediaUploadPath(videoId: VideoId): string {
  return `/api/videos/drafts/${encodeURIComponent(videoId)}/media`;
}

/** Same-origin path for uploading or reading a draft thumbnail image. */
export function draftThumbnailPath(videoId: VideoId): string {
  return `/api/videos/drafts/${encodeURIComponent(videoId)}/thumbnail`;
}
