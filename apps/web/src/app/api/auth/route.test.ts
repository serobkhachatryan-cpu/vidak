import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getW3dsAuthService: vi.fn() }));

vi.mock('../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getW3dsAuthService,
}));

import { OPTIONS, POST } from './route';

describe('eID authentication gateway route', () => {
  beforeEach(() => {
    mocks.getW3dsAuthService.mockReset();
  });

  it('accepts an eID Wallet cross-origin POST preflight', () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
  });

  it('normalizes the wallet ename payload before completing a signed offer', async () => {
    const completeOffer = vi.fn().mockResolvedValue('offer-1');
    const getOfferSessionForCookie = vi.fn().mockResolvedValue({
      tokens: { accessToken: 'wallet-access-token' },
    });
    mocks.getW3dsAuthService.mockReturnValue({ completeOffer, getOfferSessionForCookie });

    const response = await POST(
      new NextRequest('https://vidak.example/api/auth', {
        method: 'POST',
        body: JSON.stringify({
          ename: '@creator.w3id',
          session: 'session-1',
          signature: 'signature-1',
          appVersion: '0.4.0',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ token: 'wallet-access-token' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(completeOffer).toHaveBeenCalledWith({
      w3id: '@creator.w3id',
      session: 'session-1',
      signature: 'signature-1',
      appVersion: '0.4.0',
    });
    expect(getOfferSessionForCookie).toHaveBeenCalledWith('offer-1');
  });
});
