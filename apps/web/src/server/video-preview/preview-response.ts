import { type NextRequest, NextResponse } from 'next/server';
import {
  contentRangeHeader,
  parseSingleByteRange,
  unsatisfiableContentRangeHeader,
} from '../media-byte-range';
import type { PreviewDownload } from './preview-service';

type PreviewRouteResult = PreviewDownload | { status: 'processing' } | { status: 'unavailable' };

export function buildPreviewRouteResponse(
  request: NextRequest,
  result: PreviewRouteResult,
): NextResponse {
  if (result.status === 'ready') {
    return readyImageResponse(request, result.body, result.contentType);
  }
  if (result.status === 'processing') {
    return privateJson({ status: 'processing' }, 202);
  }
  return privateJson({ status: 'unavailable' }, 422);
}

function readyImageResponse(
  request: NextRequest,
  body: Uint8Array,
  contentType: string,
): NextResponse {
  const size = body.byteLength;
  const parsed = parseSingleByteRange(request.headers.get('range'), size);

  if (parsed.kind === 'invalid') {
    return privateJson({ error: { code: 'validation_failed', message: 'Invalid range.' } }, 400);
  }

  if (parsed.kind === 'unsatisfiable') {
    return new NextResponse(null, {
      status: 416,
      headers: {
        'Content-Range': unsatisfiableContentRangeHeader(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store, max-age=0',
      },
    });
  }

  if (parsed.kind === 'range') {
    const slice = body.subarray(parsed.start, parsed.end + 1);
    return new NextResponse(Buffer.from(slice), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(slice.byteLength),
        'Content-Range': contentRangeHeader(parsed.start, parsed.end, size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return new NextResponse(Buffer.from(body), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function privatePreviewErrorResponse(
  error: unknown,
  handlers: {
    auth: (error: unknown) => boolean;
    preview: (error: unknown) => boolean;
    library?: (error: unknown) => boolean;
    messageFrom: (error: unknown) => { code: string; message: string; status: number };
  },
): NextResponse {
  if (handlers.auth(error) || handlers.preview(error) || (handlers.library?.(error) ?? false)) {
    const mapped = handlers.messageFrom(error);
    return privateJson({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
  }
  return privateJson(
    { error: { code: 'internal_error', message: 'Video preview is unavailable.' } },
    500,
  );
}

function privateJson(body: unknown, status: number): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
