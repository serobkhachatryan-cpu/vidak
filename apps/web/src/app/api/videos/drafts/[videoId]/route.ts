import { type NextRequest, NextResponse } from 'next/server';
import { CreatorVideoError, getCreatorVideoService } from '../../../../../server/creator-video';
import {
  getBearerToken,
  W3dsAuthError,
  w3dsAccessCookieName,
} from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ videoId: string }> };

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof W3dsAuthError || error instanceof CreatorVideoError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Video drafts are unavailable.' } },
    { status: 500 },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    const draft = await getCreatorVideoService().getDraft(accessToken, videoId);
    return NextResponse.json(draft);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    const body = (await request.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!body || typeof body !== 'object') {
      throw new CreatorVideoError('No draft fields were provided.', 'validation_failed', 400);
    }
    const draft = await getCreatorVideoService().updateDraft(accessToken, videoId, {
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
      ...(typeof body.category === 'string' ? { category: body.category as never } : {}),
      ...(typeof body.language === 'string' ? { language: body.language as never } : {}),
      ...(typeof body.visibility === 'string' ? { visibility: body.visibility as never } : {}),
      ...(typeof body.thumbnailUrl === 'string' ? { thumbnailUrl: body.thumbnailUrl } : {}),
    });
    return NextResponse.json(draft);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const { videoId } = await context.params;
    await getCreatorVideoService().deleteDraft(accessToken, videoId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
