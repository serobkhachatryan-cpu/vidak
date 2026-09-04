import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('web security headers', () => {
  it('protects document routes from transport downgrade, framing, and untrusted content', async () => {
    const rules = await nextConfig.headers?.();
    const headers = new Map(
      rules
        ?.find((rule) => rule.source === '/:path*')
        ?.headers.map((header) => [header.key, header.value]),
    );

    expect(headers.get('Strict-Transport-Security')).toContain('includeSubDomains');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('Content-Security-Policy')).toContain("object-src 'none'");
  });
});
