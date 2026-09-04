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
    const headers =
      error instanceof MediaAssetError && error.responseHeaders ? error.responseHeaders : undefined;
    const response = NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, ...(headers ? { headers } : {}) },
    );
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Shared media is unavailable.' } },
    { status: 500, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/** Protected primary media stream for a policy-authorized recipient. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const { shareToken } = await context.params;
    const video = await getVideoSharingService().getSharedVideo(accessToken, shareToken);
    const download = await getMediaAssetService().openPrimaryPublishedDownload(video.id, {
      rangeHeader: request.headers.get('range'),
    });
    return new NextResponse(download.body, { status: download.status, headers: download.headers });
  } catch (error) {
    return errorResponse(error);
  }
}
