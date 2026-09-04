import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../server/creator-video';
import { withPublicMediaContentUrls } from '../../../../server/public-video-playback';

export const runtime = 'nodejs';

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
 * GET /api/videos/public
 * Anonymous discovery. Returns only `published` + `public` videos as a CursorPage.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const cursor = searchParams.get('cursor') ?? undefined;
    const query = searchParams.get('search') ?? undefined;
    const limitParam = searchParams.get('limit');
    const limit =
      limitParam !== null && limitParam !== '' && /^\d+$/.test(limitParam)
        ? Number(limitParam)
        : undefined;
    const page = await getCreatorVideoService().listPublicVideos({
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(query ? { query } : {}),
    });
    // Existing published rows are repaired in the background. Discovery stays
    // fast, while a later card render can use the derived public poster and
    // persisted duration instead of a permanent 0:00/blank-preview state.
    void import('../../../../server/video-preview/preview-runtime')
      .then(({ getVideoPreviewService }) =>
        getVideoPreviewService().schedulePublishedBackfill(page.items),
      )
      .catch(() => undefined);
    return NextResponse.json({
      ...page,
      items: await withPublicMediaContentUrls(page.items),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
