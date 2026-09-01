import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { buildPreviewRouteResponse } from './preview-response';

describe('preview route response', () => {
  it('returns a full image with Accept-Ranges', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const response = buildPreviewRouteResponse(
      new NextRequest('https://vidak.example/api/evault/videos/stream/preview'),
      { status: 'ready', body, contentType: 'image/jpeg' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(body));
  });

  it('honors single Range requests for poster bytes', async () => {
    const body = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const response = buildPreviewRouteResponse(
      new NextRequest('https://vidak.example/api/evault/videos/stream/preview', {
        headers: { Range: 'bytes=2-5' },
      }),
      { status: 'ready', body, contentType: 'image/jpeg' },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([2, 3, 4, 5]));
  });

  it('keeps processing and unavailable as private JSON statuses', async () => {
    const processing = buildPreviewRouteResponse(new NextRequest('https://vidak.example/preview'), {
      status: 'processing',
    });
    expect(processing.status).toBe(202);
    expect(processing.headers.get('cache-control')).toBe('private, no-store, max-age=0');

    const unavailable = buildPreviewRouteResponse(
      new NextRequest('https://vidak.example/preview'),
      { status: 'unavailable' },
    );
    expect(unavailable.status).toBe(422);
  });
});
