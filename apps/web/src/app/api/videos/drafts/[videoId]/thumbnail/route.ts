import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../../server/creator-video';
import { getMediaAssetService, MediaAssetError } from '../../../../../../server/media-asset';
import { durableDraftThumbnailUrl } from '../../../../../../server/public-video-playback';
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
  if (error instanceof W3dsAuthError || error instanceof MediaAssetError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof CreatorVideoError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Thumbnail transfer is unavailable.' } },
    { status: 500 },
  );
}

/**
 * POST /api/videos/drafts/:videoId/thumbnail
 * Authenticated raw-body thumbnail upload into an owned draft.
 * Persists a durable same-origin thumbnail path (never blob:/data:).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    await getMediaAssetService().uploadThumbnailToDraft(
      accessToken,
      videoId,
      {
        contentType: request.headers.get('content-type'),
        contentLength: request.headers.get('content-length'),
        originalFilename: request.headers.get('x-original-filename'),
      },
      request.body,
    );
    const video = await getCreatorVideoService().updateDraft(accessToken, videoId, {
      thumbnailUrl: durableDraftThumbnailUrl(videoId),
    });
    return NextResponse.json(video, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * GET /api/videos/drafts/:videoId/thumbnail
 * Authenticated stream of the draft's ready thumbnail image.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    // Ensure the caller owns the draft before streaming.
    await getCreatorVideoService().getDraft(accessToken, videoId);
    const download = await getMediaAssetService().openOwnedThumbnailDownload(accessToken, videoId);
    return new NextResponse(download.body, {
      status: download.status,
      headers: download.headers,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
