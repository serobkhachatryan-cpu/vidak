import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../../server/creator-video';
import { getMediaAssetService, MediaAssetError } from '../../../../../../server/media-asset';
import { getVideoPreviewService, VideoPreviewError } from '../../../../../../server/video-preview';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ publicVideoId: string }> };

function errorResponse(error: unknown): NextResponse {
  if (
    error instanceof CreatorVideoError ||
    error instanceof MediaAssetError ||
    error instanceof VideoPreviewError
  ) {
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

    // A real frame is the dependable default for published-video cards. Older
    // uploads can contain generic images selected by the browser as a
    // thumbnail; serving those first makes a playable video appear broken.
    // Keep a creator-provided thumbnail as a graceful fallback while the
    // server is generating a frame or the source cannot yield one.
    const generated = await getVideoPreviewService().openPublishedPreview(video.id);
    if (generated.status === 'ready') {
      return new NextResponse(Buffer.from(generated.body), {
        status: 200,
        headers: {
          'Content-Type': generated.contentType,
          'Content-Length': String(generated.body.byteLength),
          'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    try {
      const download = await getMediaAssetService().openPublishedThumbnailDownload(video.id);
      return new NextResponse(download.body, {
        status: download.status,
        headers: download.headers,
      });
    } catch (error) {
      if (!(error instanceof MediaAssetError) || error.code !== 'not_found') throw error;
    }

    return NextResponse.json({ status: generated.status }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
