import { type NextRequest, NextResponse } from 'next/server';
import { authenticationErrorResponse } from '../../../../server/ops-http';
import { getW3dsAuthService } from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await getW3dsAuthService().createOffer(request.nextUrl.origin));
  } catch (error) {
    return authenticationErrorResponse(error, request.headers);
  }
}
