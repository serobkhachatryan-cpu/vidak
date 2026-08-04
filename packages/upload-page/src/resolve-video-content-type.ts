import { supportedVideoExtensions, supportedVideoMimeTypes } from './upload-constants';

/** Resolve a Content-Type suitable for the protected media upload allowlist. */
export function resolveVideoContentType(file: { name: string; type: string }): string {
  if ((supportedVideoMimeTypes as readonly string[]).includes(file.type)) {
    return file.type;
  }
  const lower = file.name.toLocaleLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  for (const extension of supportedVideoExtensions) {
    if (lower.endsWith(extension)) {
      if (extension === '.mp4') return 'video/mp4';
      if (extension === '.webm') return 'video/webm';
      if (extension === '.mov') return 'video/quicktime';
    }
  }
  return file.type || 'application/octet-stream';
}
