/**
 * Safe single-range parsing for HTML5 media seeking (RFC 7233 subset).
 * Rejects multipart and malformed Range headers without leaking paths.
 */

export type ParsedByteRange =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'unsatisfiable' }
  | { kind: 'range'; start: number; end: number };

/**
 * Parses a single `bytes=` Range request against `size` (object length).
 * `end` is inclusive. Empty objects never satisfy a range.
 */
export function parseSingleByteRange(
  rangeHeader: string | null | undefined,
  size: number,
): ParsedByteRange {
  if (rangeHeader === null || rangeHeader === undefined || rangeHeader.trim() === '') {
    return { kind: 'absent' };
  }
  if (!Number.isInteger(size) || size < 0) {
    return { kind: 'invalid' };
  }

  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bytes=')) {
    return { kind: 'invalid' };
  }
  const spec = trimmed.slice('bytes='.length).trim();
  if (!spec || spec.includes(',')) {
    // Multipart / empty specs are rejected rather than partially applied.
    return { kind: 'invalid' };
  }

  if (size === 0) {
    return { kind: 'unsatisfiable' };
  }

  if (spec.startsWith('-')) {
    const suffix = Number(spec.slice(1));
    if (!Number.isInteger(suffix) || suffix <= 0) return { kind: 'invalid' };
    const length = Math.min(suffix, size);
    return { kind: 'range', start: size - length, end: size - 1 };
  }

  const dash = spec.indexOf('-');
  if (dash <= 0) return { kind: 'invalid' };
  const startRaw = spec.slice(0, dash);
  const endRaw = spec.slice(dash + 1);
  if (!/^\d+$/.test(startRaw) || (endRaw !== '' && !/^\d+$/.test(endRaw))) {
    return { kind: 'invalid' };
  }

  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0) return { kind: 'invalid' };
  if (start >= size) return { kind: 'unsatisfiable' };

  if (endRaw === '') {
    return { kind: 'range', start, end: size - 1 };
  }

  const end = Number(endRaw);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'invalid' };
  return { kind: 'range', start, end: Math.min(end, size - 1) };
}

export function contentRangeHeader(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

export function unsatisfiableContentRangeHeader(size: number): string {
  return `bytes */${size}`;
}
