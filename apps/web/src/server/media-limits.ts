/**
 * Server-side media transfer limits for authenticated upload routes.
 * Enforced before streaming begins and again while counting body bytes.
 */

/** Default maximum raw upload body size (100 MiB). */
export const DEFAULT_MAX_MEDIA_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Default allowlist for draft media uploads (raw body Content-Type). */
export const DEFAULT_ALLOWED_MEDIA_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;

export interface MediaUploadLimits {
  maxUploadBytes: number;
  allowedContentTypes: readonly string[];
}

export function resolveMediaUploadLimits(env: NodeJS.ProcessEnv = process.env): MediaUploadLimits {
  const maxFromEnv = env.MEDIA_MAX_UPLOAD_BYTES?.trim();
  let maxUploadBytes = DEFAULT_MAX_MEDIA_UPLOAD_BYTES;
  if (maxFromEnv) {
    const parsed = Number(maxFromEnv);
    if (Number.isInteger(parsed) && parsed > 0) {
      maxUploadBytes = parsed;
    }
  }

  const typesFromEnv = env.MEDIA_ALLOWED_CONTENT_TYPES?.trim();
  const allowedContentTypes = typesFromEnv
    ? typesFromEnv
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    : [...DEFAULT_ALLOWED_MEDIA_CONTENT_TYPES];

  return {
    maxUploadBytes,
    allowedContentTypes,
  };
}

/** Normalizes a Content-Type header to its MIME type (no parameters). */
export function normalizeContentType(headerValue: string | null | undefined): string {
  if (!headerValue) return '';
  return headerValue.split(';')[0]?.trim().toLowerCase() ?? '';
}
