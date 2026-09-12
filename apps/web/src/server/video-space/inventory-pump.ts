import 'server-only';

import { getInventoryCoordinator } from './inventory-coordinator';

let pump: ReturnType<typeof setInterval> | undefined;
const defaultPumpIntervalMs = 2_000;

/**
 * Process-level pump so inventory work continues without an open browser tab.
 * Its coordinator is single-flight; this cadence leaves the source service
 * breathing room between resumable inventory waves and interactive playback.
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
