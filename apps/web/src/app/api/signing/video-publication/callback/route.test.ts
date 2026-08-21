import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ getSigningService: vi.fn() }));

vi.mock('../../../../../server/w3ds-video-publication-signing', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../../server/w3ds-video-publication-signing')
  >()),
  getW3dsVideoPublicationSigningService: mocks.getSigningService,
}));

import { OPTIONS, POST } from './route';

describe('signed video publication callback route', () => {
  beforeEach(() => {
    mocks.getSigningService.mockReset();
  });

  it('accepts the eID Wallet CORS preflight', () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
  });

  it('passes only the documented signing callback fields to the server service', async () => {
    const completeOffer = vi.fn().mockResolvedValue({ id: 'video-1' });
    mocks.getSigningService.mockReturnValue({ completeOffer });

    const response = await POST(
      new NextRequest('https://vidak.example/api/signing/video-publication/callback', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'session-1',
          signature: 'signature-1',
          w3id: '@creator.w3id',
          message: 'session-1',
          ignored: 'not forwarded',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(completeOffer).toHaveBeenCalledWith({
      sessionId: 'session-1',
      signature: 'signature-1',
      w3id: '@creator.w3id',
      message: 'session-1',
    });
  });
});
