import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
} from '../../../../../../server/evault-video-library';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

/**
 * Warms only the viewer-bound W3DS authorization proof. It never resolves a
 * media URL or returns source metadata, so hover/focus can make the following
 * Watch action responsive without preloading private video bytes.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ streamId: string }> },
) {
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const session = await getW3dsAuthService().getSession(accessToken);
    const { streamId } = await context.params;
    await createEVaultVideoLibrary().authorizePlayableStream(session.user, streamId);
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  const known = error instanceof EVaultVideoLibraryError || error instanceof W3dsAuthError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'internal_error';
  const message = known ? error.message : 'Video authorization is unavailable.';
  return NextResponse.json(
    { error: { code, message } },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
