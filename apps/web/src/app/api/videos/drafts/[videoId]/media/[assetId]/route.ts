import { type NextRequest, NextResponse } from 'next/server';
import { getMediaAssetService, MediaAssetError } from '../../../../../../../server/media-asset';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ videoId: string; assetId: string }> };

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
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Media transfer is unavailable.' } },
    { status: 500 },
  );
}

/** GET /api/videos/drafts/:videoId/media/:assetId — owned asset metadata only. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId, assetId } = await context.params;
    const asset = await getMediaAssetService().getOwnedAsset(accessToken, videoId, assetId);
    return NextResponse.json(asset);
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/videos/drafts/:videoId/media/:assetId — row + private blob. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId, assetId } = await context.params;
    await getMediaAssetService().deleteOwnedAsset(accessToken, videoId, assetId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
