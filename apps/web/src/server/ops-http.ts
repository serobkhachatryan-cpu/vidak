/**
 * Shared HTTP helpers for correlation headers and operational auth error reporting.
 */

import { NextResponse } from 'next/server';
import {
  CORRELATION_HEADER,
  type RequestHeadersLike,
  reportOperationalFailure,
  resolveCorrelationId,
} from './ops-observability';
import { W3dsAuthError } from './w3ds-auth-errors';

export function withCorrelationId(response: NextResponse, correlationId: string): NextResponse {
  response.headers.set(CORRELATION_HEADER, correlationId);
  return response;
}

/**
 * Maps authentication failures to safe JSON responses and reports
 * configuration / unexpected server errors with correlation ids.
 */
export function authenticationErrorResponse(
  error: unknown,
  headers: RequestHeadersLike,
  fallbackMessage = 'Authentication is unavailable.',
): NextResponse {
  const correlationId = resolveCorrelationId(headers);

  if (error instanceof W3dsAuthError) {
    if (error.code === 'configuration_error' || error.status >= 500) {
      reportOperationalFailure({
        category: 'authentication',
        correlationId,
        error,
        code: error.code,
      });
    }
    return withCorrelationId(
      NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      ),
      correlationId,
    );
  }

  reportOperationalFailure({
    category: 'authentication',
    correlationId,
    error,
    code: 'internal_error',
  });
  return withCorrelationId(
    NextResponse.json(
      { error: { code: 'internal_error', message: fallbackMessage } },
      { status: 500 },
    ),
    correlationId,
  );
}
