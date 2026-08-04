import { type NextRequest, NextResponse } from 'next/server';
import { getW3dsAuthService, W3dsAuthError } from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await getW3dsAuthService().createOffer(request.nextUrl.origin));
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof W3dsAuthError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: { code: 'internal_error', message: 'Authentication is unavailable.' } },
    { status: 500 },
  );
}
