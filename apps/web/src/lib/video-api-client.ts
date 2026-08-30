import { createVideoApiClient } from '@w3ds/api-client';
import { resolveAuthProviderId } from '@w3ds/auth';
import { defaultAuthProvider } from '@w3ds/config';

/**
 * Application video client selected at build time by the browser-safe
 * `NEXT_PUBLIC_AUTH_PROVIDER` value. Development keeps the in-memory mock;
 * W3DS uses cookie-based draft routes.
 */
export const videoApiClient = createVideoApiClient({
  provider: resolveAuthProviderId(process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? defaultAuthProvider),
  dev: { delayMs: 300 },
});
