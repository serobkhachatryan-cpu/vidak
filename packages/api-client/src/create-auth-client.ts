import { type AuthClient, resolveAuthProviderId } from '@w3ds/auth';
import { MockAuthApiClient, type MockAuthApiClientOptions } from './mock-auth-client';
import { W3dsAuthClient } from './w3ds-auth-client';

export interface CreateAuthClientOptions {
  /**
   * Auth provider id or raw env value.
   * Defaults to `resolveAuthProviderId()` (`NEXT_PUBLIC_AUTH_PROVIDER` / `AUTH_PROVIDER` / `dev`).
   */
  provider?: string;
  /** Options for the development provider. */
  dev?: MockAuthApiClientOptions;
}

/**
 * Creates the auth client for the configured provider.
 * Selection is configuration-driven — not UI-driven.
 */
export function createAuthClient(options: CreateAuthClientOptions = {}): AuthClient {
  const provider = resolveAuthProviderId(options.provider);

  switch (provider) {
    case 'dev':
      return new MockAuthApiClient(options.dev);
    case 'w3ds':
      return new W3dsAuthClient();
  }
}
