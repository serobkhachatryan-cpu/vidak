import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../../server/creator-video';
import { getMediaAssetService, MediaAssetError } from '../../../../../../server/media-asset';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ publicVideoId: string }> };

function errorResponse(error: unknown): NextResponse {
  if (error instanceof CreatorVideoError || error instanceof MediaAssetError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Public thumbnail is unavailable.' } },
    { status: 500 },
  );
}

/**
 * GET /api/videos/public/:publicVideoId/thumbnail
 * Anonymous ready-thumbnail stream for a published `public` or `unlisted` video.
 * Never exposes storage keys, filesystem paths, or internal asset ids.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { publicVideoId } = await context.params;
    const video = await getCreatorVideoService().getPublicVideo(publicVideoId);
    const download = await getMediaAssetService().openPublishedThumbnailDownload(video.id);
    return new NextResponse(download.body, {
      status: download.status,
      headers: download.headers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
