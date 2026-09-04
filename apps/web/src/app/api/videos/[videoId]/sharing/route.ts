import { type NextRequest, NextResponse } from 'next/server';
import { assertTrustedMutationOrigin } from '../../../../../server/request-security';
import {
  getVideoSharingService,
  VideoSharingError,
  VideoSharingPolicyError,
} from '../../../../../server/video-sharing';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ videoId: string }> };
const privateNoStoreHeaders = { 'Cache-Control': 'private, no-store' };

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
  if (
    error instanceof W3dsAuthError ||
    error instanceof VideoSharingError ||
    error instanceof VideoSharingPolicyError
  ) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: privateNoStoreHeaders },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Sharing settings are unavailable.' } },
    { status: 500, headers: privateNoStoreHeaders },
  );
}

/** Owner-only view of a Vidak-hosted video's sharing policy. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const { videoId } = await context.params;
    return NextResponse.json(await getVideoSharingService().getOwnerPolicy(accessToken, videoId), {
      headers: privateNoStoreHeaders,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Owner-only replacement of the narrow watch policy. */
export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const body = await request.json().catch(() => undefined);
    const { videoId } = await context.params;
    return NextResponse.json(
      await getVideoSharingService().updateOwnerPolicy(accessToken, videoId, body),
      { headers: privateNoStoreHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
