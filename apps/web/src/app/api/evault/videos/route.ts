import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
} from '../../../../server/evault-video-library';
import { evaultVideoPreviewPath } from '../../../../server/video-preview/capture-time';
import type { VideoPreviewService } from '../../../../server/video-preview/preview-service';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const session = await getW3dsAuthService().getSession(accessToken);
    const library = await createEVaultVideoLibrary().listWithContext(session.user);
    let preview: VideoPreviewService | undefined;
    try {
      const { getVideoPreviewService } = await import(
        '../../../../server/video-preview/preview-runtime'
      );
      preview = getVideoPreviewService();
    } catch {
      preview = undefined;
    }
    const items = await Promise.all(
      library.items.map(async (item) => {
        const streamId = item.streamIds[0];
        const previewState = streamId
          ? preview
            ? await preview
                .peekLibraryPreview(session.user, streamId)
                .catch(() => 'processing' as const)
            : 'processing'
          : ('unavailable' as const);
        return {
          ...item,
          previewState,
          ...(streamId ? { previewUrl: evaultVideoPreviewPath(streamId) } : {}),
        };
      }),
    );
    if (preview) void preview.scheduleLibraryBackfill(session.user, library.items);
    return privateJson({ ...library, items });
  } catch (error) {
    return privateJson(errorBody(error), errorStatus(error));
  }
}

function privateJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

function errorStatus(error: unknown): number {
  return error instanceof EVaultVideoLibraryError || error instanceof W3dsAuthError
    ? error.status
    : 500;
}

function errorBody(error: unknown) {
  if (error instanceof EVaultVideoLibraryError || error instanceof W3dsAuthError) {
    return { error: { code: error.code, message: error.message } };
  }
  return { error: { code: 'internal_error', message: 'eVault videos are unavailable.' } };
}
