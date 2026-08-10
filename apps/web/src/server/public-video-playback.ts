import { publicPrimaryMediaPath } from '@w3ds/api-client';
import type { Video } from '@w3ds/types';
import { getMediaAssetService } from './media-asset';

/**
 * Attaches a same-origin public playback URL when the published video has a
 * ready media asset. Never includes storage keys, paths, or internal asset ids.
 */
export async function withPublicMediaContentUrl(video: Video): Promise<Video> {
  if (!video.publicVideoId) return video;
  if (video.status !== 'published') return video;
  if (video.visibility !== 'public' && video.visibility !== 'unlisted') return video;

  const hasMedia = await getMediaAssetService().hasPrimaryReadyAsset(video.id);
  if (!hasMedia) {
    const { mediaContentUrl: _omit, ...rest } = video;
    return rest;
  }

  return {
    ...video,
    mediaContentUrl: publicPrimaryMediaPath(video.publicVideoId),
  };
}

export async function withPublicMediaContentUrls(videos: readonly Video[]): Promise<Video[]> {
  return Promise.all(videos.map((video) => withPublicMediaContentUrl(video)));
}
