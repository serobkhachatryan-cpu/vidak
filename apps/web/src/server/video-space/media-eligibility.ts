import { parseW3dsFileUri } from '../w3ds-official-file-client';

/**
 * Documented media eligibility for authorized Meshenger / W3DS records.
 *
 * Playable cards require a `w3ds://file` identity. HTTPS URLs are never
 * trusted as stream sources. A Message `type=file` attachment without
 * filename or MIME is not discarded: it is resolved through the documented
 * eVault `metaEnvelope(id)` path on the URI's vault.
 */

export type MediaUnresolvedReason =
  | 'missing_w3ds_file_uri'
  | 'resolver_denied'
  | 'resolver_missing'
  | 'resolver_unavailable';

export type MediaDecision =
  | { status: 'accept'; fileUri: string }
  | { status: 'exclude'; reason: 'non_video' }
  | { status: 'unresolved'; reason: MediaUnresolvedReason }
  | { status: 'resolve'; fileUri: string };

const videoFilenamePattern = /\.(mp4|webm|mov|m4v|mkv|ogv|avi)(?:$|\?)/i;
const nonVideoFilenamePattern =
  /\.(zip|pdf|docx?|xlsx?|pptx?|txt|csv|json|xml|rar|7z|gz|tar)(?:$|\?)/i;
const envelopeIdPattern = /^[A-Za-z0-9._:-]+$/;
const w3dsFileOntology = 'w3ds-file-v1';
const fileOntology = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

export function constructW3dsFileUri(
  ownerEName: string,
  metaEnvelopeId: string,
): string | undefined {
  const owner = ownerEName.trim();
  const id = metaEnvelopeId.trim();
  if (!owner.startsWith('@') || !id || /\s/.test(owner) || /\s/.test(id)) return undefined;
  const fileUri = `w3ds://file?id=${owner}/${id}`;
  return parseW3dsFileUri(fileUri) ? fileUri : undefined;
}

export function documentedMediaFileUris(
  payload: Record<string, unknown>,
  vaultOwnerEName?: string,
): string[] {
  const file = record(payload.file);
  const unique = new Set<string>();
  const add = (value: unknown) => {
    const fileUri = documentedFileUri(value, vaultOwnerEName);
    if (fileUri) unique.add(fileUri);
  };
  for (const value of asArray(payload.mediaSegments)) add(value);
  add(payload.fileId);
  add(payload.mediaUri);
  add(payload.mediaUrl);
  add(file?.uri);
  add(file?.fileUri);
  add(file?.id);
  return [...unique];
}

export function classifyAuthorizedMedia(input: {
  payload: Record<string, unknown>;
  vaultOwnerEName?: string;
  resolvedContentType?: string;
  resolvedOntology?: string;
}): MediaDecision {
  const type = optionalString(input.payload.type)?.toLowerCase();
  const file = record(input.payload.file);
  const contentType = (
    input.resolvedContentType ??
    optionalString(file?.contentType) ??
    optionalString(file?.mimeType) ??
    optionalString(input.payload.contentType) ??
    optionalString(input.payload.mimeType)
  )?.toLowerCase();
  const filename = attachmentFilename(input.payload);

  if (
    isExplicitlyNonVideoMime(contentType) ||
    (filename && nonVideoFilenamePattern.test(filename))
  ) {
    return { status: 'exclude', reason: 'non_video' };
  }

  const fileUris = documentedMediaFileUris(input.payload, input.vaultOwnerEName);
  const fileUri = fileUris[0];
  const knownVideo =
    type === 'video' ||
    type === 'circle' ||
    contentType?.startsWith('video/') === true ||
    (filename ? videoFilenamePattern.test(filename) : false);

  if (knownVideo) {
    return fileUri
      ? { status: 'accept', fileUri }
      : { status: 'unresolved', reason: 'missing_w3ds_file_uri' };
  }

  if (type === 'image' || type === 'text' || type === 'system') {
    return { status: 'exclude', reason: 'non_video' };
  }

  const resolvedFileOntology =
    input.resolvedOntology === w3dsFileOntology || input.resolvedOntology === fileOntology;
  if (resolvedFileOntology && !isExplicitlyNonVideoMime(contentType)) {
    return fileUri
      ? { status: 'accept', fileUri }
      : { status: 'unresolved', reason: 'missing_w3ds_file_uri' };
  }

  if ((type === 'file' || !type) && fileUri) {
    if (input.resolvedContentType !== undefined || input.resolvedOntology) {
      return isExplicitlyNonVideoMime(contentType)
        ? { status: 'exclude', reason: 'non_video' }
        : { status: 'accept', fileUri };
    }
    return { status: 'resolve', fileUri };
  }

  return { status: 'unresolved', reason: 'missing_w3ds_file_uri' };
}

export function classifyResolvedEnvelope(input: {
  fileUri: string;
  payload: Record<string, unknown>;
  ontology: string;
}): MediaDecision {
  const contentType =
    optionalString(input.payload.contentType) ?? optionalString(input.payload.mimeType);
  return classifyAuthorizedMedia({
    payload: {
      type: 'file',
      ...input.payload,
      mediaUri: input.fileUri,
    },
    ...(contentType ? { resolvedContentType: contentType } : {}),
    resolvedOntology: input.ontology,
  });
}

function documentedFileUri(value: unknown, vaultOwnerEName?: string): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  if (parseW3dsFileUri(text)) return text;
  if (/^https?:\/\//i.test(text)) return undefined;
  if (vaultOwnerEName && envelopeIdPattern.test(text) && !text.includes('/')) {
    return constructW3dsFileUri(vaultOwnerEName, text);
  }
  return undefined;
}

function attachmentFilename(message: Record<string, unknown>): string | undefined {
  const file = record(message.file);
  return (
    optionalString(file?.filename) ??
    optionalString(file?.name) ??
    optionalString(message.filename) ??
    optionalString(message.name)
  );
}

function isExplicitlyNonVideoMime(mime: string | undefined): boolean {
  if (!mime) return false;
  if (mime.startsWith('video/')) return false;
  if (
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('text/') ||
    mime === 'application/pdf' ||
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'application/x-7z-compressed' ||
    mime === 'application/gzip' ||
    mime === 'application/x-tar' ||
    mime.startsWith('application/msword') ||
    mime.startsWith('application/vnd.')
  ) {
    return true;
  }
  return mime.startsWith('application/') || mime.startsWith('multipart/');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
