/**
 * Shared redaction for operational logs and persisted failure summaries.
 * Strips cookies, bearer tokens, credentials, authorization headers, and
 * sensitive configuration (database URLs, JWT secrets, storage paths).
 */

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+=/]+/gi,
  /(?:^|[\s,;])(?:Cookie|Set-Cookie)\s*[:=]\s*[^;\n\r]+/gi,
  /(?:^|[\s,;"])(?:authorization)\s*[:=]\s*['"]?[^'"\s,;]+/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /(?:api[_-]?key|secret|password|token|authorization|jwtSecret|W3DS_AUTH_JWT_SECRET|DATABASE_URL|MEDIA_STORAGE_ROOT)\s*[:=]\s*['"]?[^'"\s,;]+/gi,
  /https?:\/\/[^/\s:@]+:[^/@\s]+@[^\s]+/gi,
  /postgres(?:ql)?:\/\/[^/\s:@]+:[^/@\s]+@[^\s]+/gi,
  /(?:^|[\s"'])(?:\/(?:var|tmp|home|Users|app|data)\/[^\s"']+)/g,
];

export function redactSensitiveText(
  value: unknown,
  fallback = 'Operation failed.',
  maxLength = 240,
): string {
  let raw = '';
  if (value instanceof Error) {
    raw = value.message;
  } else if (typeof value === 'string') {
    raw = value;
  } else if (value && typeof value === 'object') {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = fallback;
    }
  } else if (value === undefined || value === null) {
    raw = fallback;
  } else {
    raw = String(value);
  }

  let redacted = raw;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  redacted = redacted.replace(/\s+/g, ' ').trim();
  if (!redacted) return fallback;
  if (redacted.length > maxLength) {
    redacted = `${redacted.slice(0, maxLength - 3)}...`;
  }
  return redacted;
}

/** Ensures a log line never embeds credential material (values, not env names). */
export function assertNoSensitiveLeak(serialized: string): void {
  const forbidden = ['postgresql://', 'postgres://', 'Bearer ', 'Cookie:', 'Set-Cookie:'];
  for (const needle of forbidden) {
    if (serialized.includes(needle)) {
      throw new Error(`Operational payload must not reveal sensitive material (${needle}).`);
    }
  }
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(serialized)) {
    throw new Error('Operational payload must not reveal JWT material.');
  }
}
