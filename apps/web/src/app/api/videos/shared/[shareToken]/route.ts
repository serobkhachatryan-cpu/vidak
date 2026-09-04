import { type NextRequest, NextResponse } from 'next/server';
import {
  getVideoSharingService,
  VideoSharingError,
  withSharedVideoPlaybackUrls,
} from '../../../../../server/video-sharing';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ shareToken: string }> };

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof W3dsAuthError || error instanceof VideoSharingError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Shared video is unavailable.' } },
    { status: 500, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/** Signed-in recipient view. A share URL is not sufficient without a matching eID grant. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const { shareToken } = await context.params;
    const video = await getVideoSharingService().getSharedVideo(accessToken, shareToken);
    return NextResponse.json(withSharedVideoPlaybackUrls(video, shareToken), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
