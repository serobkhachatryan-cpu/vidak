import { type NextRequest, NextResponse } from 'next/server';
import {
  ChannelImportCatalogError,
  getChannelImportCatalogService,
} from '../../../../server/channel-import-catalog';
import { getBearerToken, W3dsAuthError, w3dsAccessCookieName } from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

export async function GET(request: NextRequest) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const rawLimit = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10);
    const items = await getChannelImportCatalogService().listVideos(accessToken, rawLimit);
    return privateJson({ items });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ChannelImportCatalogError) {
    return privateJson({ error: { message: error.message } }, error.status);
  }
  if (error instanceof W3dsAuthError) {
    return privateJson({ error: { message: error.message } }, error.status);
  }
  return privateJson({ error: { message: 'Imported videos are unavailable.' } }, 500);
}

function privateJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
