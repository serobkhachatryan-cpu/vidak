import { draftThumbnailPath, publicPrimaryMediaPath, publicThumbnailPath } from '@w3ds/api-client';
import { normalizePersistedThumbnailUrl, type Video } from '@w3ds/types';
import { getMediaAssetService } from './media-asset';

/**
 * Attaches a same-origin public playback URL when the published video has a
 * ready media asset. Never includes storage keys, paths, or internal asset ids.
 * Also resolves a durable thumbnail URL (never `blob:` / `data:`).
 */
export async function withPublicMediaContentUrl(video: Video): Promise<Video> {
  let next = video;

  if (
    video.publicVideoId &&
    video.status === 'published' &&
    (video.visibility === 'public' || video.visibility === 'unlisted')
  ) {
    const hasMedia = await getMediaAssetService().hasPrimaryReadyAsset(video.id);
    if (hasMedia) {
      next = {
        ...next,
        mediaContentUrl: publicPrimaryMediaPath(video.publicVideoId),
      };
    } else {
      const { mediaContentUrl: _omit, ...rest } = next;
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
 * Clears ephemeral `blob:` / `data:` values. Prefers a ready thumbnail asset
 * over any previously stored string.
 */
export async function withPublicThumbnailUrl(video: Video): Promise<Video> {
  if (
    video.publicVideoId &&
    video.status === 'published' &&
    (video.visibility === 'public' || video.visibility === 'unlisted')
  ) {
    const hasThumbnail = await getMediaAssetService().hasReadyThumbnailAsset(video.id);
    if (hasThumbnail) {
      return {
        ...video,
        thumbnailUrl: publicThumbnailPath(video.publicVideoId),
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
