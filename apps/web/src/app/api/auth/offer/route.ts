import { type NextRequest, NextResponse } from 'next/server';
import { authenticationErrorResponse } from '../../../../server/ops-http';
import {
  loadServerSecurityConfig,
  type ServerSecurityConfig,
} from '../../../../server/server-config';
import { getW3dsAuthService } from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

/**
 * Uses the configured public app origin for eID callback links. A reverse proxy
 * legitimately makes Next.js see its internal listener (`localhost:3910`),
 * which must never be presented to an external wallet.
 */
export function resolveOfferPublicOrigin(
  request: NextRequest,
  config: Pick<ServerSecurityConfig, 'trustedOrigins'> = loadServerSecurityConfig(),
): string {
  return config.trustedOrigins[0] ?? request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(
      await getW3dsAuthService().createOffer(resolveOfferPublicOrigin(request)),
    );
  } catch (error) {
    return authenticationErrorResponse(error, request.headers);
  }
}
