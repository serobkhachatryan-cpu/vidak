import type { Metadata } from 'next';
import { getCreatorVideoService } from '../../../server/creator-video';
import { withPublicThumbnailUrl } from '../../../server/public-video-playback';

const vidakOrigin = 'https://vidak.postplatforms.com';

function publicImageUrl(value: string): string | undefined {
  const url = value.trim();
  if (!url) return undefined;

  try {
    return new URL(url, vidakOrigin).toString();
  } catch {
    return undefined;
  }
}

export async function generateWatchPageMetadata(videoId: string): Promise<Metadata> {
  try {
    const video = await getCreatorVideoService().getPublicVideo(videoId);
    const publicVideo = await withPublicThumbnailUrl(video);
    const imageUrl = publicImageUrl(publicVideo.thumbnailUrl);
    if (!imageUrl) return {};

    const title = publicVideo.title.trim() || 'Video';
    const description = publicVideo.description.trim() || `Watch ${title} on Vidak.`;
    const watchUrl = `/watch/${encodeURIComponent(videoId)}`;

    return {
      title,
      description,
      alternates: { canonical: watchUrl },
      openGraph: {
        type: 'video.other',
        url: watchUrl,
        title,
        description,
        images: [{ url: imageUrl, alt: `${title} video preview` }],
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [imageUrl],
      },
    };
  } catch {
    // Preserve the site-wide Vidak preview when this is not a public video.
    return {};
  }
}
