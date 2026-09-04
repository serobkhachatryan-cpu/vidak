import { type NextRequest, NextResponse } from 'next/server';
import { getMediaAssetService, MediaAssetError } from '../../../../../../server/media-asset';
import { getVideoSharingService, VideoSharingError } from '../../../../../../server/video-sharing';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ shareToken: string }> };

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
  if (
    error instanceof W3dsAuthError ||
    error instanceof VideoSharingError ||
    error instanceof MediaAssetError
  ) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Shared thumbnail is unavailable.' } },
    { status: 500 },
  );
}

/** Protected poster stream for a policy-authorized recipient. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const { shareToken } = await context.params;
    const video = await getVideoSharingService().getSharedVideo(accessToken, shareToken);
    try {
      const download = await getMediaAssetService().openPublishedThumbnailDownload(video.id);
      return new NextResponse(download.body, {
        status: download.status,
        headers: download.headers,
      });
    } catch (error) {
      if (!(error instanceof MediaAssetError) || error.code !== 'not_found') throw error;
      return new NextResponse(null, { status: 404 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
