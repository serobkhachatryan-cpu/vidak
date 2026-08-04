import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { callbackInputFromSearchParams, resolveCallbackPublicOrigin } from './route';

describe('W3DS eID callback route', () => {
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
});
