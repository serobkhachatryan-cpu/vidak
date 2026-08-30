import { type NextRequest, NextResponse } from 'next/server';
import { getW3dsAuthService } from '../../../../../server/w3ds-auth';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ userId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const { userId } = await context.params;
  const result = await getW3dsAuthService().readPublicAvatar(userId);
  if (!result) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Avatar was not found.' } },
      { status: 404 },
    );
  }
  return new NextResponse(Buffer.from(result.body), {
    status: 200,
    headers: {
      'Content-Type': result.contentType,
      'Content-Length': String(result.body.byteLength),
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
