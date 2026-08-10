import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../../server/creator-video';
import { getMediaAssetService, MediaAssetError } from '../../../../../../server/media-asset';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ publicVideoId: string }> };

function errorResponse(error: unknown): NextResponse {
  if (error instanceof CreatorVideoError || error instanceof MediaAssetError) {
    const headers =
      error instanceof MediaAssetError && error.responseHeaders
        ? { ...error.responseHeaders }
        : undefined;
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, ...(headers ? { headers } : {}) },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Public media is unavailable.' } },
    { status: 500 },
  );
}

/**
 * GET /api/videos/public/:publicVideoId/media
 * Anonymous primary ready-asset stream for a published `public` or `unlisted`
 * video. Never exposes storage keys, filesystem paths, or internal asset ids.
 * Supports safe single byte-range requests for HTML5 seeking.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { publicVideoId } = await context.params;
    const video = await getCreatorVideoService().getPublicVideo(publicVideoId);
    const download = await getMediaAssetService().openPrimaryPublishedDownload(video.id, {
      rangeHeader: request.headers.get('range'),
    });
    return new NextResponse(download.body, {
      status: download.status,
      headers: download.headers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
