/**
 * Request correlation and structured server-side operational error reporting.
 * Logs are JSON lines to stderr — no third-party telemetry vendors.
 */

import { randomUUID } from 'node:crypto';
import { assertNoSensitiveLeak, redactSensitiveText } from './ops-redaction';

export const CORRELATION_HEADER = 'x-request-id';
export const CORRELATION_HEADER_ALT = 'x-correlation-id';

export type OperationalFailureCategory =
  | 'authentication'
  | 'media_storage'
  | 'migration_readiness'
  | 'w3ds_sync';

export type RequestHeadersLike = {
  get(name: string): string | null;
};

export interface OperationalFailureReport {
  level: 'error';
  category: OperationalFailureCategory;
  correlationId: string;
  code?: string;
  message: string;
}

export type OperationalLogSink = (line: string) => void;

const defaultLogSink: OperationalLogSink = (line) => {
  // Keep Vitest output quiet unless a test installs an explicit sink.
  if (process.env.NODE_ENV === 'test') return;
  console.error(line);
};

let logSink: OperationalLogSink = defaultLogSink;

/** Test helper to capture structured operational logs. */
export function setOperationalLogSinkForTests(sink: OperationalLogSink | undefined): void {
  logSink = sink ?? defaultLogSink;
}

export function createCorrelationId(): string {
  return randomUUID();
}

/**
 * Resolves a caller-supplied correlation id or creates one.
 * Accepts `X-Request-Id` or `X-Correlation-Id`.
 */
export function resolveCorrelationId(headers: RequestHeadersLike): string {
  const fromRequest =
    normalizeCorrelationId(headers.get(CORRELATION_HEADER)) ??
    normalizeCorrelationId(headers.get(CORRELATION_HEADER_ALT));
  return fromRequest ?? createCorrelationId();
}

export function normalizeCorrelationId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // Keep ids opaque and log-safe; reject control characters / huge values.
  if (trimmed.length > 128 || /[^\x20-\x7E]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Emits a redacted structured error for operational categories.
 * Never logs cookies, bearer tokens, credentials, or sensitive config values.
 */
export function reportOperationalFailure(input: {
  category: OperationalFailureCategory;
  error: unknown;
  correlationId?: string;
  code?: string;
}): OperationalFailureReport {
  const report: OperationalFailureReport = {
    level: 'error',
    category: input.category,
    correlationId: input.correlationId ?? createCorrelationId(),
    message: redactSensitiveText(input.error, `${input.category} failure`),
    ...(input.code ? { code: input.code } : {}),
  };

  const line = JSON.stringify(report);
  assertNoSensitiveLeak(line);
  logSink(line);
  return report;
}
