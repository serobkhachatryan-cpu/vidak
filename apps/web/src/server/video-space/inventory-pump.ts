import 'server-only';

import { getInventoryCoordinator } from './inventory-coordinator';

let pump: ReturnType<typeof setInterval> | undefined;
// This is intentionally slower than a page's progress poll. A catalogue
// request must never turn into an implicit remote eVault drain; the durable
// worker yields between waves so interactive playback has clear priority on
// the constrained host.
const defaultPumpIntervalMs = 30_000;

/**
 * Process-level pump so inventory work continues without an open browser tab.
 * Its coordinator is single-flight. A durable wave can touch an external
 * eVault, so leave a meaningful gap between waves: explicit Watch requests
 * must win over catalogue catch-up on the constrained production host.
 */
export function startInventoryJobPump(intervalMs = defaultPumpIntervalMs): void {
  if (pump || process.env.NEXT_PHASE === 'phase-production-build') return;
  console.info('[inventory-pump] started');
  pump = setInterval(() => {
    void getInventoryCoordinator().pumpRunning();
  }, intervalMs);
  pump.unref?.();
}

export function stopInventoryJobPumpForTests(): void {
  if (!pump) return;
  clearInterval(pump);
  pump = undefined;
}
