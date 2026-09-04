const fixedDiagnosticPaths = new Set([
  '/',
  '/auth/handoff',
  '/createanapp',
  '/deeplink-login',
  '/library',
  '/login',
  '/meshenger',
  '/register',
  '/search',
  '/settings',
  '/subscriptions',
  '/support',
  '/upload',
  '/your-videos',
]);

const dynamicDiagnosticPaths: Array<readonly [RegExp, string]> = [
  [/^\/watch\/space\/[^/]+$/, '/watch/space/[video]'],
  [/^\/watch\/imported\/[^/]+$/, '/watch/imported/[video]'],
  [/^\/watch\/[^/]+$/, '/watch/[video]'],
  [/^\/channel\/[^/]+$/, '/channel/[channel]'],
  [/^\/user\/[^/]+$/, '/user/[user]'],
];

/**
 * Support diagnostics identify the page type without retaining a video,
 * channel, user, or private-library record identifier.
 */
export function supportDiagnosticPath(pathname: unknown): string {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || /[?#\\\r\n]/.test(pathname)) {
    return '/other';
  }
  if (fixedDiagnosticPaths.has(pathname)) return pathname;
  return dynamicDiagnosticPaths.find(([pattern]) => pattern.test(pathname))?.[1] ?? '/other';
}
