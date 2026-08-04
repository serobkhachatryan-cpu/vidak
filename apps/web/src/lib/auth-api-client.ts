import { createAuthClient } from '@w3ds/api-client';
import { resolveAuthProviderId } from '@w3ds/auth';
import { authProviderEnvVars, defaultAuthProvider } from '@w3ds/config';

/**
 * Application auth client selected by `NEXT_PUBLIC_AUTH_PROVIDER` / `AUTH_PROVIDER`.
 * Defaults to the development provider so existing behavior is unchanged.
 */
export const authApiClient = createAuthClient({
  provider: resolveAuthProviderId(
    process.env[authProviderEnvVars.public] ??
      process.env[authProviderEnvVars.shared] ??
      defaultAuthProvider,
  ),
  dev: { delayMs: 300 },
});
