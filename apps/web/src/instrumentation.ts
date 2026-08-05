/**
 * Next.js server instrumentation — validates security configuration at startup.
 * Fails fast in production when AUTH_PROVIDER/W3DS/origin settings are incomplete.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // `next build` may load instrumentation; validate when the Node server boots.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { validateServerConfigAtStartup } = await import('./server/server-config');
  const config = validateServerConfigAtStartup();

  // This is deliberately opt-in and server-only. It creates/reuses Vidak's
  // platform eVault; it never changes the user eID authentication flow.
  if (config.w3ds?.platformEVault) {
    const { ensureW3dsPlatformEVault } = await import('./server/w3ds-platform-evault');
    await ensureW3dsPlatformEVault({
      registryBaseUrl: config.w3ds.registryBaseUrl,
      platformEVault: config.w3ds.platformEVault,
    });
  }
}
