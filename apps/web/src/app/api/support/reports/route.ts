import { type NextRequest, NextResponse } from 'next/server';
import {
  reportOperationalFailure,
  resolveCorrelationId,
} from '../../../../server/ops-observability';
import { assertTrustedMutationOrigin } from '../../../../server/request-security';
import { getSupportReportService, SupportReportError } from '../../../../server/support-report';
import { getBearerToken, W3dsAuthError, w3dsAccessCookieName } from '../../../../server/w3ds-auth';

export const runtime = 'nodejs';

function accessTokenFrom(request: NextRequest): string | undefined {
  return getBearerToken(request.headers) ?? request.cookies.get(w3dsAccessCookieName)?.value;
}

export async function GET(request: NextRequest) {
  try {
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    return privateJson({ items: await getSupportReportService().listForReporter(accessToken) });
  } catch (error) {
    return errorResponse(error, request);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertTrustedMutationOrigin(request);
    const accessToken = accessTokenFrom(request);
    if (!accessToken) {
      throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
    }
    const body = (await request.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!body || typeof body !== 'object') {
      throw new SupportReportError('Please describe the problem.', 'invalid_report', 400);
    }
    const report = await getSupportReportService().submit(accessToken, {
      description: body.description,
      includeTechnicalDetails: body.includeTechnicalDetails,
      allowAutomatedAnalysis: body.allowAutomatedAnalysis,
      ...(body.technicalDiagnostics && typeof body.technicalDiagnostics === 'object'
        ? {
            technicalDiagnostics: body.technicalDiagnostics as Record<string, unknown>,
          }
        : {}),
    });
    return privateJson({ report }, 201);
  } catch (error) {
    return errorResponse(error, request);
  }
}

function errorResponse(error: unknown, request: NextRequest): NextResponse {
  if (error instanceof W3dsAuthError || error instanceof SupportReportError) {
    return privateJson({ error: { code: error.code, message: error.message } }, error.status);
  }

  const correlationId = resolveCorrelationId(request.headers);
  reportOperationalFailure({
    category: 'support',
    error,
    correlationId,
    code: 'support_intake_failed',
  });
  return privateJson(
    {
      error: {
        code: 'internal_error',
        message: 'Your report could not be submitted. Please try again.',
        correlationId,
      },
    },
    500,
  );
}

function privateJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
