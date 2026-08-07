import { describe, expect, it } from 'vitest';
import {
  buildAuthHandoffPath,
  buildCookieHandoffHtml,
  buildLoginPath,
  buildOfferContinuePath,
  getSafeReturnTo,
} from './auth-session-handoff';

describe('auth session handoff helpers', () => {
  it('keeps same-origin returnTo values and rejects open redirects', () => {
    expect(getSafeReturnTo('/settings')).toBe('/settings');
    expect(getSafeReturnTo('/upload')).toBe('/upload');
    expect(getSafeReturnTo('https://evil.example/')).toBe('/');
    expect(getSafeReturnTo('//evil.example')).toBe('/');
    expect(getSafeReturnTo(null)).toBe('/');
  });

  it('normalizes login and handoff return targets to prevent soft loops', () => {
    expect(getSafeReturnTo('/login')).toBe('/');
    expect(getSafeReturnTo('/login?returnTo=%2Fsettings')).toBe('/');
    expect(getSafeReturnTo('/auth/handoff')).toBe('/');
    expect(getSafeReturnTo('/auth/handoff?returnTo=%2Fupload')).toBe('/');
  });

  it('builds the cookie continuation and post-cookie handoff paths', () => {
    expect(buildOfferContinuePath('offer-1', '/settings')).toBe(
      '/api/auth/offer/offer-1/continue?returnTo=%2Fsettings',
    );
    expect(buildAuthHandoffPath('/upload')).toBe('/auth/handoff?returnTo=%2Fupload');
    expect(buildAuthHandoffPath('/login')).toBe('/auth/handoff?returnTo=%2F');
    expect(buildLoginPath('/settings')).toBe('/login?returnTo=%2Fsettings');
    const html = buildCookieHandoffHtml('/auth/handoff?returnTo=%2Fsettings');
    expect(html).toContain('url=/auth/handoff?returnTo=%2Fsettings');
    expect(html).toContain('location.replace("/auth/handoff?returnTo=%2Fsettings")');
    expect(html).toMatch(/content="1;url=/);
  });
});
