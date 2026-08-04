import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../server/creator-video';
import { assertTrustedMutationOrigin } from '../../../../../server/request-security';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ videoId: string }> };

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof W3dsAuthError || error instanceof CreatorVideoError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Video publishing is unavailable.' } },
    { status: 500 },
  );
}

/**
 * POST /api/videos/:videoId/unpublish
 * Authenticated owner unpublish. Lifecycle rules are enforced by CreatorVideoService.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    const video = await getCreatorVideoService().unpublishVideo(accessToken, videoId);
    return NextResponse.json(video);
  } catch (error) {
    return errorResponse(error);
  }
}
