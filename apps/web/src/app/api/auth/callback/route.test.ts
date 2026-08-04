import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getW3dsAuthService: vi.fn() }));

vi.mock('../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getW3dsAuthService,
}));

import { callbackInputFromSearchParams, POST, resolveCallbackPublicOrigin } from './route';

describe('W3DS eID callback route', () => {
  beforeEach(() => {
    mocks.getW3dsAuthService.mockReset();
  });

  it('accepts the eID wallet browser-redirect field names', () => {
    expect(
      callbackInputFromSearchParams(
        new URLSearchParams({
          ename: '@creator.w3id',
          session: 'offer-session',
          signature: 'wallet-signature',
          appVersion: '0.7.1',
        }),
      ),
    ).toEqual({
      w3id: '@creator.w3id',
      session: 'offer-session',
      signature: 'wallet-signature',
      appVersion: '0.7.1',
    });
  });

  it('uses the external application origin after an eID wallet redirect', () => {
    const request = new NextRequest('http://localhost:3910/api/auth/callback');

    expect(
      resolveCallbackPublicOrigin(request, {
        trustedOrigins: ['https://vidak.postplatforms.com'],
      }),
    ).toBe('https://vidak.postplatforms.com');
  });

  it('returns the access token expected by the eID wallet after verification', async () => {
    const completeOffer = vi.fn().mockResolvedValue('offer-1');
    const getOfferSessionForCookie = vi.fn().mockResolvedValue({
      tokens: { accessToken: 'wallet-access-token' },
    });
    mocks.getW3dsAuthService.mockReturnValue({ completeOffer, getOfferSessionForCookie });

    const response = await POST(
      new NextRequest('https://vidak.example/api/auth/callback', {
        method: 'POST',
        body: JSON.stringify({
          w3id: '@creator.w3id',
          session: 'session-1',
          signature: 'signature-1',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ token: 'wallet-access-token' });
    expect(completeOffer).toHaveBeenCalledWith({
      w3id: '@creator.w3id',
      session: 'session-1',
      signature: 'signature-1',
    });
    expect(getOfferSessionForCookie).toHaveBeenCalledWith('offer-1');
  });
});
