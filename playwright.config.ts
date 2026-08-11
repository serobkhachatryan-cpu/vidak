import { defineConfig, devices } from '@playwright/test';

/**
 * E2E boots the web app with a non-production W3DS stub:
 * in-memory auth store + local identity verifier (no wallet, registry, or DB).
 */
const w3dsE2eEnv = {
  AUTH_PROVIDER: 'w3ds',
  NEXT_PUBLIC_AUTH_PROVIDER: 'w3ds',
  APP_ORIGIN: 'http://127.0.0.1:3000',
  W3DS_AUTH_PLATFORM_NAME: 'vidak',
  W3DS_REGISTRY_BASE_URL: 'http://127.0.0.1:9',
  W3DS_AUTH_JWT_SECRET: 'e2e-only-test-secret-at-least-32-chars',
  W3DS_AUTH_E2E_STUB: '1',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'on-first-retry' },
  webServer: {
    command:
      'rm -rf apps/web/.next apps/web/.data/w3ds-e2e-auth-state.json && pnpm --filter @w3ds/web dev',
    url: 'http://127.0.0.1:3000',
    // Stub env must win over a developer `next dev` already bound to :3000.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      ...w3dsE2eEnv,
      CHOKIDAR_USEPOLLING: '1',
      WATCHPACK_POLLING: 'true',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
