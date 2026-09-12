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

const maxExactItemIdLength = 8_192;

export async function GET(request: NextRequest) {
  try {
    const accessToken =
      getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const session = await getW3dsAuthService().getSession(accessToken);
    const scope = parseInventoryScope(request.nextUrl.searchParams.get('scope')) ?? 'all';
    const refresh = request.nextUrl.searchParams.get('refresh') === '1';
    const requestedItemId = request.nextUrl.searchParams.get('itemId');

    if (requestedItemId !== null) {
      // Watch only needs one viewer-scoped card. The coordinator first checks
      // its short-lived memory cache, then the owner's exact persisted card;
      // neither path starts or waits for a source inventory scan. A missing or
      // stale retained card falls back inside the coordinator to the existing
      // viewer-authorized snapshot behavior.
      const item = isSafeExactItemId(requestedItemId)
        ? await getInventoryCoordinator().getItem(session.user, {
            itemId: requestedItemId,
            scope,
            refresh,
          })
        : undefined;
      return privateJson({
        items: item ? [item] : [],
        conversations: [],
        messages: [],
        scope,
      });
    }

    const snapshot = await getInventoryCoordinator().getSnapshot(session.user, { scope, refresh });

    const previewService = await loadPreviewService();

    const items = await Promise.all(
      snapshot.items.map(async (item) => attachPreviewFields(item, session.user, previewService)),
    );
    const personalPreviewItems = snapshot.items.filter(
      (item) => item.accessScope === 'personal' && item.streamIds.length > 0,
    );
    if (previewService && personalPreviewItems.length > 0) {
      // Owned previews are local to this service, so repairing them from the
      // catalogue has no effect on a shared source. Shared posters are queued
      // only by their viewport-driven image route: starting every remote
      // source after each library response kept a large catalogue busy enough
      // to contend with a viewer opening one of its videos. The card route
      // still creates every shared preview as it becomes visible.
      void previewService
        .scheduleLibraryBackfill(session.user, personalPreviewItems)
        .catch(() => undefined);
    }

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

/**
 * `itemId` is compared as an exact opaque catalogue key. Do not normalize it:
 * a similar-looking identifier must never select another private library item.
 */
function isSafeExactItemId(value: string): boolean {
  return value.length > 0 && value.length <= maxExactItemIdLength && !value.includes('\u0000');
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

  if (item.accessScope !== 'personal') {
    // Reporting cached state only validates the short-lived, viewer-bound
    // stream token. The preview route separately rechecks live source access
    // before it returns image bytes, so this cannot turn an old shared grant
    // into durable poster access.
    let previewState: VideoPreviewState = 'processing';
    if (previewService) {
      try {
        previewState = await previewService.peekCachedLibraryPreview(user, streamId);
      } catch {
        // A preview is an enhancement: a stale stream token must not hide an
        // otherwise authorized catalogue card.
      }
    }
    return {
      ...item,
      previewState,
      previewUrl: evaultVideoPreviewPath(streamId),
    };
  }

  let previewState: VideoPreviewState = 'processing';
  if (previewService) {
    try {
      previewState = await previewService.peekLibraryPreview(user, streamId);
    } catch {
      // A poster is an enhancement, not a prerequisite for returning an
      // authorized library card or opening another personal video. Keep this
      // card's preview in its safe failed state without failing the catalogue.
      previewState = 'unavailable';
    }
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
