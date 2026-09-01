import { type NextRequest, NextResponse } from 'next/server';
import { EVaultVideoLibraryError } from '../../../../server/evault-video-library';
import { evaultVideoPreviewPath } from '../../../../server/video-preview/capture-time';
import type { VideoPreviewState } from '../../../../server/video-preview/preview-service';
import { parseInventoryScope } from '../../../../server/video-space/discovery';
import { getInventoryCoordinator } from '../../../../server/video-space/inventory-coordinator';
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
    const scope = parseInventoryScope(request.nextUrl.searchParams.get('scope')) ?? 'all';
    const refresh = request.nextUrl.searchParams.get('refresh') === '1';
    const snapshot = await getInventoryCoordinator().getSnapshot(session.user, { scope, refresh });
    const previewService = await loadPreviewService();

    if (previewService) {
      void previewService
        .scheduleLibraryBackfill(session.user, snapshot.items)
        .catch(() => undefined);
    }

    const items = await Promise.all(
      snapshot.items.map(async (item) => attachPreviewFields(item, session.user, previewService)),
    );

    return privateJson({
      items,
      conversations: snapshot.conversations,
      messages: snapshot.messages,
      completeness: snapshot.completeness,
      discovery: snapshot.discovery,
      scope: snapshot.scope,
      metrics: snapshot.metrics,
    });
  } catch (error) {
    return privateJson(errorBody(error), errorStatus(error));
  }
}

async function loadPreviewService() {
  try {
    const { getVideoPreviewService } = await import(
      '../../../../server/video-preview/preview-runtime'
    );
    return getVideoPreviewService();
  } catch {
    return undefined;
  }
}

async function attachPreviewFields(
  item: Awaited<
    ReturnType<ReturnType<typeof getInventoryCoordinator>['getSnapshot']>
  >['items'][number],
  user: { eName: string },
  previewService: Awaited<ReturnType<typeof loadPreviewService>>,
) {
  const streamId = item.streamIds[0];
  if (!streamId) {
    return { ...item, previewState: 'unavailable' as const };
  }

  let previewState: VideoPreviewState = 'processing';
  if (previewService) {
    previewState = await previewService.peekLibraryPreview(user, streamId);
  }

  return {
    ...item,
    previewState,
    previewUrl: evaultVideoPreviewPath(streamId),
  };
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
