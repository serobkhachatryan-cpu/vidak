/**
 * Same-origin eID completion lands on `/auth/handoff` after offer continuation
 * applies HttpOnly session cookies. The handoff route verifies the cookie
 * session server-side and issues an HTTP redirect to a safe `returnTo`.
 */

export function getSafeReturnTo(returnTo: string | null | undefined): string {
  if (!returnTo?.startsWith('/') || returnTo.startsWith('//')) return '/';

  const pathOnly = returnTo.split(/[?#]/)[0] ?? '/';
  // Prevent soft loops through login / handoff itself.
  if (
    pathOnly === '/login' ||
    pathOnly === '/auth/handoff' ||
    pathOnly.startsWith('/login/') ||
    pathOnly.startsWith('/auth/handoff/')
  ) {
    return '/';
  }

  return returnTo;
}

/** Path the offer continuation redirects to after setting session cookies. */
export function buildAuthHandoffPath(returnTo: string): string {
  const search = new URLSearchParams({ returnTo: getSafeReturnTo(returnTo) });
  return `/auth/handoff?${search.toString()}`;
}

/** Full navigation into the cookie-producing offer continuation. */
export function buildOfferContinuePath(offerId: string, returnTo: string): string {
  const search = new URLSearchParams({ returnTo: getSafeReturnTo(returnTo) });
  return `/api/auth/offer/${encodeURIComponent(offerId)}/continue?${search.toString()}`;
}

export function buildLoginPath(returnTo: string, offerId?: string): string {
  const search = new URLSearchParams({ returnTo: getSafeReturnTo(returnTo) });
  if (offerId) search.set('offer', offerId);
  return `/login?${search.toString()}`;
}

/**
 * HTML body that advances to handoff after Set-Cookie on a 200 response.
 * Browsers often omit cookies set on a 3xx from the immediate next hop.
 */
export function buildCookieHandoffHtml(handoffPath: string): string {
  const target = handoffPath.startsWith('/') && !handoffPath.startsWith('//') ? handoffPath : '/';
  const safeTarget = target.replace(/"/g, '');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta http-equiv="refresh" content="0;url=${safeTarget}"/><title>Signing in</title></head><body><p>Signing you in…</p><p><a href="${safeTarget}">Continue</a></p></body></html>`;
}
