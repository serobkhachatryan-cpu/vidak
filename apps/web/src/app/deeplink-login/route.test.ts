import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { resolvePublicOrigin } from '../../server/public-origin';

describe('eID deep-link completion route', () => {
  it('uses the configured public origin behind the reverse proxy', () => {
    const request = new NextRequest('http://localhost:3910/deeplink-login');

    expect(
      resolvePublicOrigin(request, {
        trustedOrigins: ['https://vidak.postplatforms.com'],
      }),
    ).toBe('https://vidak.postplatforms.com');
  });
});
