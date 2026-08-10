import { type NextRequest, NextResponse } from 'next/server';
import {
  CreatorVideoError,
  getCreatorVideoService,
} from '../../../../../../../../server/creator-video';
import { getMediaAssetService, MediaAssetError } from '../../../../../../../../server/media-asset';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ publicVideoId: string; assetId: string }> };

function errorResponse(error: unknown): NextResponse {
  if (error instanceof CreatorVideoError || error instanceof MediaAssetError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Public media is unavailable.' } },
    { status: 500 },
  );
}

/**
 * GET /api/videos/public/:publicVideoId/media/:assetId/content
 * Anonymous ready-asset stream for a published `public` or `unlisted` video.
 * Visibility is enforced via getPublicVideo before any storage read.
 * Never returns storage keys, filesystem paths, or session data.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { publicVideoId, assetId } = await context.params;
    const video = await getCreatorVideoService().getPublicVideo(publicVideoId);
    const download = await getMediaAssetService().openPublishedDownload(video.id, assetId);
    return new NextResponse(download.body, {
      status: download.status,
      headers: download.headers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
