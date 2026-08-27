import { type NextRequest, NextResponse } from 'next/server';
import { getChannelImportService } from '../../../../../server/channel-import-service';
import { getBearerToken, w3dsAccessCookieName } from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get('error')) return settingsRedirect(request, 'cancelled');
  const accessToken = accessTokenFrom(request);
  const state = request.nextUrl.searchParams.get('state') ?? '';
  const code = request.nextUrl.searchParams.get('code') ?? '';
  if (!accessToken || !state || !code) return settingsRedirect(request, 'failed');

  try {
    await getChannelImportService().completeAuthorization({
      accessToken,
      providerInput: 'vimeo',
      state,
      code,
    });
    return settingsRedirect(request, 'connected');
  } catch {
    // Provider details, credentials, and callback parameters are private.
    return settingsRedirect(request, 'failed');
  }
}

function settingsRedirect(request: NextRequest, result: 'connected' | 'cancelled' | 'failed') {
  const url = new URL('/settings', request.nextUrl.origin);
  url.searchParams.set('channelImport', result);
  const response = NextResponse.redirect(url);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
