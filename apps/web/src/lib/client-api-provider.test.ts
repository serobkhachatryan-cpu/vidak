import { W3dsVideoApiClient } from '@w3ds/api-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('browser API provider selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('selects the W3DS clients when the browser build provider is W3DS', async () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDER', 'w3ds');

    const [{ authApiClient }, { videoApiClient }] = await Promise.all([
      import('./auth-api-client'),
      import('./video-api-client'),
    ]);

    expect(authApiClient.provider).toBe('w3ds');
    expect(videoApiClient).toBeInstanceOf(W3dsVideoApiClient);
    expect(authApiClient.capabilities.emailPasswordLogin).toBe(false);
    expect(authApiClient.capabilities.w3dsAuthChallenge).toBe(true);
  });
});
