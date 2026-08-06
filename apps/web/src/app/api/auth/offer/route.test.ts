import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { resolveOfferPublicOrigin } from './route';

describe('W3DS auth offer route', () => {
  it('uses the configured public origin instead of a reverse proxy listener', () => {
    const request = new NextRequest('http://localhost:3910/api/auth/offer');

    expect(
      resolveOfferPublicOrigin(request, {
        trustedOrigins: ['https://vidak.postplatforms.com'],
      }),
    ).toBe('https://vidak.postplatforms.com');
  });

  it('uses the request origin only when no public origin is configured', () => {
    const request = new NextRequest('http://localhost:3910/api/auth/offer');

    expect(resolveOfferPublicOrigin(request, { trustedOrigins: [] })).toBe('http://localhost:3910');
  });
});
