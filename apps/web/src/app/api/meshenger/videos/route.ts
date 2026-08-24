import { type NextRequest, NextResponse } from 'next/server';
import {
  createMeshengerVideoLibrary,
  MeshengerVideoLibraryError,
} from '../../../../server/meshenger-video-library';
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
    return privateJson({ items: await createMeshengerVideoLibrary().list(session.user) });
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
  return error instanceof MeshengerVideoLibraryError || error instanceof W3dsAuthError
    ? error.status
    : 500;
}

function errorBody(error: unknown) {
  if (error instanceof MeshengerVideoLibraryError || error instanceof W3dsAuthError) {
    return { error: { code: error.code, message: error.message } };
  }
  return { error: { code: 'internal_error', message: 'Meshenger videos are unavailable.' } };
}
