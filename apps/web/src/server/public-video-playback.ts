import {
  draftThumbnailPath,
  publicMediaContentPath,
  publicPrimaryMediaPath,
  publicThumbnailPath,
} from '@w3ds/api-client';
import { normalizePersistedThumbnailUrl, type Video, type VideoMediaRendition } from '@w3ds/types';
import { getMediaAssetService, type PublicMediaAsset } from './media-asset';

/**
 * Attaches a same-origin public playback URL when the published video has a
 * ready media asset. Never includes storage keys or filesystem paths; secondary
 * rendition URLs use opaque public asset ids. Also resolves a durable thumbnail
 * URL (never `blob:` / `data:`).
 */
export async function withPublicMediaContentUrl(video: Video): Promise<Video> {
  let next = video;
  const publicVideoId = video.publicVideoId;

  if (
    publicVideoId &&
    video.status === 'published' &&
    (video.visibility === 'public' || video.visibility === 'unlisted')
  ) {
    const videoAssets = await getMediaAssetService().listPublishedVideoAssets(video.id);
    if (videoAssets.length > 0) {
      const mediaContentUrl = publicPrimaryMediaPath(publicVideoId);
      next = {
        ...next,
        mediaContentUrl,
        mediaRenditions: videoAssets.map((asset, index) =>
          toMediaRendition(publicVideoId, asset, index),
        ),
      };
    } else {
      const {
        mediaContentUrl: _mediaContentUrl,
        mediaRenditions: _mediaRenditions,
        ...rest
      } = next;
      void _mediaContentUrl;
      void _mediaRenditions;
      next = rest;
    }
  }

  return withPublicThumbnailUrl(next);
}

export async function withPublicMediaContentUrls(videos: readonly Video[]): Promise<Video[]> {
  return Promise.all(videos.map((video) => withPublicMediaContentUrl(video)));
}

/**
 * Resolves a durable same-origin thumbnail URL for public responses.
 * Clears ephemeral `blob:` / `data:` values. A published video with playable
 * media always points to the public thumbnail route: that route derives a
 * durable still frame and retains an uploaded poster only as a fallback. The
 * revision prevents a browser from retaining an old generic poster after a
 * video frame has been repaired.
 */
export async function withPublicThumbnailUrl(video: Video): Promise<Video> {
  if (
    video.publicVideoId &&
    video.status === 'published' &&
    (video.visibility === 'public' || video.visibility === 'unlisted')
  ) {
    const hasThumbnail = await getMediaAssetService().hasReadyThumbnailAsset(video.id);
    const hasPlayableMedia = await getMediaAssetService().hasPrimaryReadyAsset(video.id);
    if (hasThumbnail || hasPlayableMedia) {
      return {
        ...video,
        thumbnailUrl: versionedPublicThumbnailPath(video.publicVideoId, video.updatedAt),
      };
    }
  }

  return sanitizePublicThumbnailUrl(video);
}

/** Clears ephemeral / unsafe thumbnail URLs from a public video projection. */
export function sanitizePublicThumbnailUrl(video: Video): Video {
  return {
    ...video,
    thumbnailUrl: normalizePersistedThumbnailUrl(video.thumbnailUrl),
  };
}

/** Durable draft thumbnail path used after a successful thumbnail upload. */
export function durableDraftThumbnailUrl(videoId: string): string {
  return draftThumbnailPath(videoId);
}

export function versionedPublicThumbnailPath(publicVideoId: string, updatedAt: string): string {
  const path = publicThumbnailPath(publicVideoId);
  const revision = updatedAt.trim();
  return revision ? `${path}?v=${encodeURIComponent(revision)}` : path;
}

function toMediaRendition(
  publicVideoId: string,
  asset: PublicMediaAsset,
  index: number,
): VideoMediaRendition {
  const isPrimary = index === 0;
  return {
    id: isPrimary ? 'original' : asset.id,
    label: isPrimary ? 'Original' : inferRenditionLabel(asset, index),
    kind: isPrimary ? 'original' : 'transcoded',
    mediaContentUrl: isPrimary
      ? publicPrimaryMediaPath(publicVideoId)
      : publicMediaContentPath(publicVideoId, asset.id),
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    isDefault: isPrimary,
  };
}

function inferRenditionLabel(asset: PublicMediaAsset, index: number): string {
  const match = asset.originalFilename.match(/(?:^|[^0-9])([1-9][0-9]{2,3})p(?:[^0-9]|$)/i);
  return match?.[1] ? `${match[1]}p` : `Option ${index + 1}`;
}
