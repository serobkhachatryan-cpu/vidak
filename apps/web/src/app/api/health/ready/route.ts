import { type NextRequest, NextResponse } from 'next/server';
import { CORRELATION_HEADER, resolveCorrelationId } from '../../../../server/ops-observability';
import { checkReadiness, reportReadinessFailure } from '../../../../server/ops-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOT_READY_BODY = {
  error: {
    code: 'not_ready',
    message: 'Service is not ready.',
  },
} as const;

/**
 * Readiness probe: configuration and required runtime dependencies.
 * Failures return a generic body — never credentials, paths, URLs, or secrets.
 */
export async function GET(request: NextRequest) {
  const correlationId = resolveCorrelationId(request.headers);
  const result = await checkReadiness();

  if (!result.ready) {
    reportReadinessFailure(result, correlationId);
    return NextResponse.json(NOT_READY_BODY, {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        [CORRELATION_HEADER]: correlationId,
      },
    });
  }

  return NextResponse.json(
    { status: 'ready' },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        [CORRELATION_HEADER]: correlationId,
      },
    },
  );
}
