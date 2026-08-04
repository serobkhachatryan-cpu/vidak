import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { resolveDeeplinkPublicOrigin } from './route';

describe('eID deep-link completion route', () => {
  it('uses the configured public origin behind the reverse proxy', () => {
    const request = new NextRequest('http://localhost:3910/deeplink-login');

    expect(
      resolveDeeplinkPublicOrigin(request, {
        trustedOrigins: ['https://vidak.postplatforms.com'],
      }),
    ).toBe('https://vidak.postplatforms.com');
  });
});
