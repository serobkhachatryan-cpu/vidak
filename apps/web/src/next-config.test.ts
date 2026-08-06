import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Next build configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exposes the server-selected provider to the browser build', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'w3ds');
    vi.stubEnv('NEXT_PUBLIC_AUTH_PROVIDER', '');

    const { default: config } = await import('../next.config');

    expect(config.env?.NEXT_PUBLIC_AUTH_PROVIDER).toBe('w3ds');
  });
});
