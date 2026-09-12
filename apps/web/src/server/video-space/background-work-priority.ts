// Playback is interactive; catalogue and preview repair are resumable. Keep a
// process-local reservation so a private video request is not competing with
// a large background scan or a new frame extraction on the same small host.
let interactivePlaybackUntil = 0;
const activeBackgroundWork = new Map<AbortController, string | undefined>();
const interactiveSourceUntil = new Map<string, number>();

// Give the player a short head start over preview extraction. Longer source
// priority is scoped to its eVault in MeshengerVideoLibrary, so unrelated
// catalogue and preview work cannot be held indefinitely by range requests.
export const interactivePlaybackReservationMs = 30_000;

export interface BackgroundWorkLease {
  signal: AbortSignal;
  release: () => void;
}

export function reserveInteractivePlayback(durationMs: number, now = Date.now()): void {
  interactivePlaybackUntil = Math.max(interactivePlaybackUntil, now + Math.max(0, durationMs));
  // Previews are resumable derivatives, while playback is an explicitly
  // requested private media stream. Abort only work that opted into this
  // lease; unrelated requests retain their existing behavior.
  for (const controller of activeBackgroundWork.keys()) controller.abort();
  activeBackgroundWork.clear();
}

export function backgroundWorkDelayMs(now = Date.now()): number {
  return Math.max(0, interactivePlaybackUntil - now);
}

/**
 * Registers one cancellable, resumable background task. A source scope lets a
 * Watch action preempt only the in-flight metadata read for that same eVault.
 */
export function beginBackgroundWork(sourceScope?: string): BackgroundWorkLease {
  const controller = new AbortController();
  const scope = normalizeScope(sourceScope);
  activeBackgroundWork.set(controller, scope);
  const now = Date.now();
  // A task can be registered just after an interactive request has made its
  // reservation. Treat it as preempted too, rather than waiting for a later
  // reservation to abort it. This closes the small scheduling gap for card
  // preview authorization and other resumable work.
  if (interactivePlaybackUntil > now || (scope && (interactiveSourceUntil.get(scope) ?? 0) > now)) {
    controller.abort();
  }
  return {
    signal: controller.signal,
    release: () => activeBackgroundWork.delete(controller),
  };
}

/**
 * Reserve one source for an interactive opening. This never pauses unrelated
 * work; it only stops a resumable task already reading the same eVault.
 */
export function reserveInteractiveSourceWork(
  sourceScope: string,
  durationMs: number,
  now = Date.now(),
): void {
  pruneExpiredSourceReservations(now);
  const target = normalizeScope(sourceScope);
  if (!target) return;
  interactiveSourceUntil.set(
    target,
    Math.max(interactiveSourceUntil.get(target) ?? 0, now + Math.max(0, durationMs)),
  );
  for (const [controller, activeScope] of activeBackgroundWork) {
    if (activeScope !== target) continue;
    controller.abort();
    activeBackgroundWork.delete(controller);
  }
}

export function resetBackgroundWorkPriorityForTests(): void {
  for (const controller of activeBackgroundWork.keys()) controller.abort();
  activeBackgroundWork.clear();
  interactiveSourceUntil.clear();
  interactivePlaybackUntil = 0;
}

function normalizeScope(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function pruneExpiredSourceReservations(now: number): void {
  for (const [scope, expiresAt] of interactiveSourceUntil) {
    if (expiresAt <= now) interactiveSourceUntil.delete(scope);
  }
}
