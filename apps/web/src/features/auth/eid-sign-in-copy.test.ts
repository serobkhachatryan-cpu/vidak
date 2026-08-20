import { describe, expect, it } from 'vitest';
import { eidSignInCopy, isW3dsProtocolUri, visibleEidSignInCopyValues } from './eid-sign-in-copy';

describe('eID sign-in product copy', () => {
  it('keeps QR/deeplink protocol detection for href values only', () => {
    expect(isW3dsProtocolUri('w3ds://auth?session=abc&platform=vidak')).toBe(true);
    expect(isW3dsProtocolUri('https://vidak.example/login')).toBe(false);
    expect(isW3dsProtocolUri(eidSignInCopy.linkText)).toBe(false);
  });

  it('does not teach w3ds:// or protocol services as login copy', () => {
    expect(eidSignInCopy.linkLabel).toBe('Sign-in link');
    expect(eidSignInCopy.linkText).toBe('Continue with eID');

    for (const value of visibleEidSignInCopyValues()) {
      expect(value).not.toMatch(/w3ds:\/\//i);
      expect(value).not.toMatch(/registry|evault|ontology|graphql|schemaId/i);
    }
  });
});
