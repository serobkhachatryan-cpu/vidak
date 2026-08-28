import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../../server/creator-video';
import { getMediaAssetService, MediaAssetError } from '../../../../../../server/media-asset';
import { assertTrustedMutationOrigin } from '../../../../../../server/request-security';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ videoId: string }> };

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
  if (
    error instanceof W3dsAuthError ||
    error instanceof MediaAssetError ||
    error instanceof CreatorVideoError
  ) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Media transfer is unavailable.' } },
    { status: 500 },
  );
}

/**
 * GET /api/videos/drafts/:videoId/media
 * Lists the signed-in owner's video assets for resuming a saved draft.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    // A media row alone is never enough: this route only resumes an editable, owned draft.
    await getCreatorVideoService().getDraft(accessToken, videoId);
    const items = await getMediaAssetService().listOwnedVideoAssets(accessToken, videoId);
    return NextResponse.json({ items });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/videos/drafts/:videoId/media
 * Authenticated raw-body upload into an owned draft. Streams bytes; no multipart.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    const asset = await getMediaAssetService().uploadToDraft(
      accessToken,
      videoId,
      {
        contentType: request.headers.get('content-type'),
        contentLength: request.headers.get('content-length'),
        originalFilename: request.headers.get('x-original-filename'),
      },
      request.body,
    );
    return NextResponse.json(asset, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
