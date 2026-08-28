import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../server/creator-video';
import { getBearerToken, W3dsAuthError, w3dsAccessCookieName } from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

/** Lists only local Vidak videos owned by the signed-in person. */
export async function GET(request: NextRequest) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const items = await getCreatorVideoService().listOwnedVideos(accessToken);
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof W3dsAuthError || error instanceof CreatorVideoError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'Your Vidak videos are unavailable.' } },
      { status: 500 },
    );
  }
}
