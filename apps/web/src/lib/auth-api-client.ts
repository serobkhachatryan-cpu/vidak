import { createAuthClient } from '@w3ds/api-client';
import { resolveAuthProviderId } from '@w3ds/auth';
import { defaultAuthProvider } from '@w3ds/config';

/**
 * Application auth client selected at build time by the browser-safe
 * `NEXT_PUBLIC_AUTH_PROVIDER` value. Next.js only inlines direct environment
 * property access in client bundles; a computed `process.env[...]` lookup
 * would fall back to the development provider in production.
 */
export const authApiClient = createAuthClient({
  provider: resolveAuthProviderId(process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? defaultAuthProvider),
  dev: { delayMs: 300 },
});
