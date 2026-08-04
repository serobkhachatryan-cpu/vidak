import { resolveAuthProviderId } from '@w3ds/auth';
import { MockVideoApiClient, type MockVideoApiClientOptions } from './mock-video-client';
import type { VideoApiClient } from './video-client';
import { W3dsVideoApiClient, type W3dsVideoApiClientOptions } from './w3ds-video-client';

export interface CreateVideoApiClientOptions {
  /**
   * Auth provider id or raw env value.
   * Defaults to `resolveAuthProviderId()` (`NEXT_PUBLIC_AUTH_PROVIDER` / `AUTH_PROVIDER` / `dev`).
   */
  provider?: string;
  /** Options for the development mock video client. */
  dev?: MockVideoApiClientOptions;
  /** Options for the W3DS cookie-based draft client. */
  w3ds?: W3dsVideoApiClientOptions;
}

/**
 * Creates the video API client for the configured auth provider.
 * Development keeps `MockVideoApiClient`; W3DS uses cookie draft routes.
 */
export function createVideoApiClient(options: CreateVideoApiClientOptions = {}): VideoApiClient {
  const provider = resolveAuthProviderId(options.provider);

  switch (provider) {
    case 'dev':
      return new MockVideoApiClient(options.dev);
    case 'w3ds':
      return new W3dsVideoApiClient(options.w3ds);
  }
}
