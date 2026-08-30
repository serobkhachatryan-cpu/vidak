import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../../server/creator-video';
import { withPublicMediaContentUrl } from '../../../../../../server/public-video-playback';
import { hashedPublicViewerKeyFromRequest } from '../../../../../../server/public-video-views';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ publicVideoId: string }> };

function errorResponse(error: unknown): NextResponse {
  if (error instanceof CreatorVideoError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'View counting is unavailable.' } },
    { status: 500 },
  );
}

/**
 * POST /api/videos/public/:publicVideoId/views
 * Anonymous view event after meaningful Watch-page playback.
 * Deduplicates by a one-way viewer hash. Never stores IP/eName/tokens,
 * never writes eVault, and never changes visibility.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { publicVideoId } = await context.params;
    const viewerKeyHash = hashedPublicViewerKeyFromRequest(request, publicVideoId);
    const result = await getCreatorVideoService().recordPublicView(publicVideoId, viewerKeyHash);
    return NextResponse.json({
      counted: result.counted,
      video: await withPublicMediaContentUrl(result.video),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
