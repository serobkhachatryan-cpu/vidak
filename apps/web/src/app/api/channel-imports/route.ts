import { type NextRequest, NextResponse } from 'next/server';
import {
  ChannelImportError,
  getChannelImportService,
} from '../../../server/channel-import-service';
import { getBearerToken, W3dsAuthError, w3dsAccessCookieName } from '../../../server/w3ds-auth';

export const runtime = 'nodejs';

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

export async function GET(request: NextRequest) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const service = getChannelImportService();
    const [items, providers] = await Promise.all([
      service.listImportedChannels(accessToken),
      Promise.resolve(service.providerStatuses()),
    ]);
    return privateJson({ items, providers });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ChannelImportError || error instanceof W3dsAuthError) {
    return privateJson({ error: { code: error.code, message: error.message } }, error.status);
  }
  return privateJson(
    { error: { code: 'internal_error', message: 'Channel imports are unavailable.' } },
    500,
  );
}

function privateJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
