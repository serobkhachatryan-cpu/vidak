import { type AuthClient, resolveAuthProviderId } from '@w3ds/auth';
import { MockAuthApiClient, type MockAuthApiClientOptions } from './mock-auth-client';
import { W3dsAuthClient, type W3dsAuthClientOptions } from './w3ds-auth-client';

export interface CreateAuthClientOptions {
  /**
   * Auth provider id or raw env value.
   * Defaults to `resolveAuthProviderId()` (`NEXT_PUBLIC_AUTH_PROVIDER` / `AUTH_PROVIDER` / `dev`).
   */
  provider?: string;
  /** Options for the development provider. */
  dev?: MockAuthApiClientOptions;
  /** Options for the W3DS platform HTTP provider. */
  w3ds?: W3dsAuthClientOptions;
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
      return new W3dsAuthClient(options.w3ds);
  }
}
