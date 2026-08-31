import 'server-only';

import { getInventoryCoordinator } from './inventory-coordinator';

let pump: ReturnType<typeof setInterval> | undefined;

/** Process-level pump so inventory work continues without an open browser tab. */
export function startInventoryJobPump(intervalMs = 750): void {
  if (pump || process.env.NEXT_PHASE === 'phase-production-build') return;
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
