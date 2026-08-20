/**
 * Product-visible eID login copy.
 *
 * The wallet still receives a `w3ds://auth` deeplink via QR value and `<a href>`.
 * Visible text must stay product language ("sign-in link" / "Continue with eID")
 * and must never teach protocol internals.
 */

export const eidSignInCopy = {
  heading: 'Sign in with eID',
  intro:
    'Continue with your eID wallet to sign in. Scan the code or open the sign-in link on this device.',
  approveHint:
    'Approve the request in your eID wallet. This page finishes automatically when approval completes.',
  linkLabel: 'Sign-in link',
  linkText: 'Continue with eID',
  waiting: 'Waiting for eID approval…',
  continueButton: 'Continue with eID',
  retryButton: 'Try again',
  newRequest: 'Create a new eID request',
  qrAlt: 'QR code for eID sign-in',
} as const;

const W3DS_PROTOCOL_URI = /w3ds:\/\//i;

export function isW3dsProtocolUri(value: string): boolean {
  return W3DS_PROTOCOL_URI.test(value);
}

/** Visible login strings that must not include protocol URIs or protocol service names. */
export function visibleEidSignInCopyValues(): readonly string[] {
  return Object.values(eidSignInCopy);
}
