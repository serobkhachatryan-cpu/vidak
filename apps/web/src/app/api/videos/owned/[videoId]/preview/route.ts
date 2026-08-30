import { type NextRequest, NextResponse } from 'next/server';
import { getVideoPreviewService, VideoPreviewError } from '../../../../../../server/video-preview';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ videoId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const session = await getW3dsAuthService().getSession(accessToken);
    const { videoId } = await context.params;
    const result = await getVideoPreviewService().openOwnedPreview(session.user, videoId);
    return previewResponse(result);
  } catch (error) {
    return previewError(error);
  }
}

function previewResponse(
  result:
    | { status: 'ready'; body: Uint8Array; contentType: string }
    | { status: 'processing' }
    | { status: 'unavailable' },
): NextResponse {
  if (result.status === 'ready') {
    return new NextResponse(Buffer.from(result.body), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.body.byteLength),
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (result.status === 'processing') {
    return privateJson({ status: 'processing' }, 202);
  }
  return privateJson({ status: 'unavailable' }, 422);
}

function previewError(error: unknown): NextResponse {
  if (error instanceof W3dsAuthError || error instanceof VideoPreviewError) {
    return privateJson({ error: { code: error.code, message: error.message } }, error.status);
  }
  return privateJson(
    { error: { code: 'internal_error', message: 'Video preview is unavailable.' } },
    500,
  );
}

function privateJson(body: unknown, status: number): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
