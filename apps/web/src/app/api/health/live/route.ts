import { type NextRequest, NextResponse } from 'next/server';
import { CORRELATION_HEADER, resolveCorrelationId } from '../../../../server/ops-observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness probe: process can accept HTTP.
 * Does not inspect dependencies or disclose internal state.
 */
export async function GET(request: NextRequest) {
  const correlationId = resolveCorrelationId(request.headers);
  return NextResponse.json(
    { status: 'ok' },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        [CORRELATION_HEADER]: correlationId,
      },
    },
  );
}
