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
    'Use eID to open your private Vidak video space. Public Vidak videos can be watched without signing in.',
  approveHint:
    'Your first sign-in connects your existing eID to a Vidak profile; it does not create another eID or account. Approve the request in your eID wallet to continue.',
  linkLabel: 'Sign-in link',
  linkText: 'Continue with eID',
  waiting: 'Waiting for eID approval…',
  checking: 'Checking for eID approval…',
  requestExpired: 'This eID request expired. Create a new request to try again.',
  requestFailed: 'This eID request could not be approved. Create a new request to try again.',
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
