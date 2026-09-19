/**
 * Next.js server instrumentation — validates security configuration at startup.
 * Fails fast in production when AUTH_PROVIDER/W3DS/origin settings are incomplete.
 */

export async function register(): Promise<void> {
  // In a standalone production server Next invokes instrumentation without
  // setting NEXT_RUNTIME. Treat only an explicit Edge runtime as unsupported;
  // otherwise the inventory pump would never start after deployment.
  if (process.env.NEXT_RUNTIME === 'edge') return;
  // `next build` may load instrumentation; validate when the Node server boots.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { validateServerConfigAtStartup } = await import('./server/server-config');
  const config = validateServerConfigAtStartup();

  const { startInventoryJobPump } = await import('./server/video-space/inventory-pump');
  startInventoryJobPump();

  const { startDurablePreviewRepairPump } = await import(
    './server/video-preview/durable-repair-pump'
  );
  startDurablePreviewRepairPump();

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
