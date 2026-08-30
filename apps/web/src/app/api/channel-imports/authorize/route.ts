import { type NextRequest, NextResponse } from 'next/server';
import {
  ChannelImportError,
  getChannelImportService,
} from '../../../../server/channel-import-service';
import { assertTrustedMutationOrigin } from '../../../../server/request-security';
import { getBearerToken, W3dsAuthError, w3dsAccessCookieName } from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    if (!accessToken)
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    const body = (await request.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    const result = await getChannelImportService().beginAuthorization(accessToken, body?.provider);
    return privateJson(result);
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ChannelImportError || error instanceof W3dsAuthError) {
    return privateJson({ error: { code: error.code, message: error.message } }, error.status);
  }
  return privateJson(
    { error: { code: 'internal_error', message: 'Could not start channel import.' } },
    500,
  );
}

function privateJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
