import { loadServerSecurityConfig, type ServerSecurityConfig } from './server-config';

/**
 * Resolves the externally reachable application origin when Next.js is behind
 * a reverse proxy. The configured trusted origin takes precedence over the
 * internal listener origin visible to the request handler.
 */
export function resolvePublicOrigin(
  request: Request,
  config: Pick<ServerSecurityConfig, 'trustedOrigins'> = loadServerSecurityConfig(),
): string {
  return config.trustedOrigins[0] ?? new URL(request.url).origin;
}
