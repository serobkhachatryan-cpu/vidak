import { describe, expect, it } from 'vitest';
import { resolveContinuePublicOrigin } from './route';

describe('W3DS auth offer continuation route', () => {
  it('redirects through the configured public origin instead of the reverse proxy listener', () => {
    const request = new Request('http://localhost:3910/api/auth/offer/example/continue');

    expect(
      resolveContinuePublicOrigin(request, {
        trustedOrigins: ['https://vidak.postplatforms.com'],
      }),
    ).toBe('https://vidak.postplatforms.com');
  });
});
