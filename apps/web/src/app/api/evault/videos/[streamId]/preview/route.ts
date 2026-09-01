import type { NextRequest, NextResponse } from 'next/server';
import { EVaultVideoLibraryError } from '../../../../../../server/evault-video-library';
import { getVideoPreviewService, VideoPreviewError } from '../../../../../../server/video-preview';
import {
  buildPreviewRouteResponse,
  privatePreviewErrorResponse,
} from '../../../../../../server/video-preview/preview-response';
import {
  getBearerToken,
  getW3dsAuthService,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ streamId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const session = await getW3dsAuthService().getSession(accessToken);
    const { streamId } = await context.params;
    const result = await getVideoPreviewService().openEVaultPreview(session.user, streamId);
    return buildPreviewRouteResponse(request, result);
  } catch (error) {
    return previewError(error);
  }
}

function previewError(error: unknown): NextResponse {
  return privatePreviewErrorResponse(error, {
    auth: (value) => value instanceof W3dsAuthError,
    preview: (value) => value instanceof VideoPreviewError,
    library: (value) => value instanceof EVaultVideoLibraryError,
    messageFrom: (value) => {
      if (value instanceof W3dsAuthError || value instanceof VideoPreviewError) {
        return { code: value.code, message: value.message, status: value.status };
      }
      if (value instanceof EVaultVideoLibraryError) {
        return { code: value.code, message: value.message, status: value.status };
      }
      return { code: 'internal_error', message: 'Video preview is unavailable.', status: 500 };
    },
  });
}
