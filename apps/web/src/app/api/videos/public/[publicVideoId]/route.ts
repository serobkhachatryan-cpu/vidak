import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../server/creator-video';

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
    { error: { code: 'internal_error', message: 'Public videos are unavailable.' } },
    { status: 500 },
  );
}

/**
 * GET /api/videos/public/:publicVideoId
 * Anonymous published-video detail. Resolves `public` or `unlisted` published
 * videos only; drafts and `private` rows return 404.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { publicVideoId } = await context.params;
    const video = await getCreatorVideoService().getPublicVideo(publicVideoId);
    return NextResponse.json(video);
  } catch (error) {
    return errorResponse(error);
  }
}
