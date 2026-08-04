import { createVideoApiClient } from '@w3ds/api-client';
import { resolveAuthProviderId } from '@w3ds/auth';
import { authProviderEnvVars, defaultAuthProvider } from '@w3ds/config';

/**
 * Application video client selected by `NEXT_PUBLIC_AUTH_PROVIDER` / `AUTH_PROVIDER`.
 * Development keeps the in-memory mock; W3DS uses cookie-based draft routes.
 */
export const videoApiClient = createVideoApiClient({
  provider: resolveAuthProviderId(
    process.env[authProviderEnvVars.public] ??
      process.env[authProviderEnvVars.shared] ??
      defaultAuthProvider,
  ),
  dev: { delayMs: 300 },
  w3ds: { mock: { delayMs: 300 } },
});
