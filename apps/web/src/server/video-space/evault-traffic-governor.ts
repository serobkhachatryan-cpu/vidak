import 'server-only';

/**
 * The current eVault deployment applies a platform-wide read quota. A large
 * catalogue therefore cannot be allowed to fan out background requests just
 * because those reads target different people or different eVault origins.
 *
 * Interactive playback always wins. Background work is resumable, so it uses
 * one global lane with a deliberately conservative cadence. This governor is
 * only for eVault GraphQL/File reads; Registry calls use a different service
 * and retain their existing cache/coalescing policy.
 */
export type EVaultTrafficClass = 'background' | 'interactive';

export interface EVaultTrafficLease {
  signal: AbortSignal;
  release: () => void;
}

/**
 * Holds the background lane while one user-confirmed playback transaction
 * performs several eVault reads (proof, File redirect, legacy fallback).
 */
export interface EVaultInteractiveTrafficSession {
  release: () => void;
}

// The deployed eVault currently applies a 250 request/minute platform bucket.
// Sustain an average of at most four eVault control-request starts per second
// after a bounded foreground proof batch. This is deliberately a *start*
// cadence rather than a response-held mutex: the canonical File -> GraphQL
// fallback must still be able to begin while a slow File redirect is in flight.
const controlRequestSpacingMs = 250;
// A fully addressed shared CallSession legitimately reads three independent,
// exact records at once. Preserve that small foreground batch so the queue
// itself cannot consume its 2.5-second proof deadline. The bucket refills at
// the same four-per-second rate, so it remains bounded across rapid clicks.
const interactiveControlBurstSize = 3;
// Background discovery is resumable and can involve slow historical vaults.
// Keep its established single-flight, one-per-second behaviour on top of the
// global cadence so it cannot turn latency into a growing upstream backlog.
const backgroundRequestSpacingMs = 1_000;

interface ActiveBackgroundRequest {
  controller: AbortController;
}

interface PendingEVaultRequest {
  trafficClass: EVaultTrafficClass;
  signal?: AbortSignal;
  resolve: (lease: EVaultTrafficLease | undefined) => void;
  onAbort?: () => void;
}

const activeBackgroundRequests = new Set<ActiveBackgroundRequest>();
let pendingInteractiveRequests: PendingEVaultRequest[] = [];
let pendingBackgroundRequests: PendingEVaultRequest[] = [];
let nextControlRequestAt = 0;
let nextBackgroundRequestAt = 0;
let interactiveControlBurstTokens = interactiveControlBurstSize;
let interactiveControlBurstRefilledAt = 0;
let scheduledPump: ReturnType<typeof setTimeout> | undefined;
let interactiveTrafficSessions = 0;
const interactiveTrafficPreemption = Symbol('interactive-eVault-traffic-preemption');

/** True only when a foreground Watch deliberately displaced this request. */
export function isEVaultTrafficPreempted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === interactiveTrafficPreemption;
}

/**
 * Starts a transaction-wide foreground reservation. Interactive eVault
 * requests receive the next permitted global start slot, while background work
 * cannot slip between two proof/File requests belonging to the same Watch
 * action.
 */
export function beginInteractiveEVaultTrafficSession(): EVaultInteractiveTrafficSession {
  interactiveTrafficSessions += 1;
  preemptBackgroundTraffic();
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      interactiveTrafficSessions = Math.max(0, interactiveTrafficSessions - 1);
      if (interactiveTrafficSessions === 0) pumpEVaultTrafficRequests();
    },
  };
}

/**
 * Acquires one outbound eVault control-request lease. Starts are globally
 * paced across GraphQL and header-only File dereferences, but a lease is not
 * held as a semaphore: a fallback request can start at the next cadence slot
 * while the previous source request is still waiting for headers.
 *
 * A missing lease means a cancellable caller was aborted/preempted and must
 * yield its durable work. It never represents an authorization outcome.
 */
export function acquireEVaultTrafficLease(input: {
  trafficClass: EVaultTrafficClass;
  signal?: AbortSignal;
}): Promise<EVaultTrafficLease | undefined> {
  if (input.signal?.aborted) return Promise.resolve(undefined);
  if (input.trafficClass === 'interactive') preemptBackgroundTraffic();

  return new Promise<EVaultTrafficLease | undefined>((resolve) => {
    const pending: PendingEVaultRequest = input.signal
      ? { trafficClass: input.trafficClass, signal: input.signal, resolve }
      : { trafficClass: input.trafficClass, resolve };
    if (input.signal) {
      pending.onAbort = () => {
        removePendingRequest(pending);
        resolve(undefined);
        pumpEVaultTrafficRequests();
      };
      input.signal.addEventListener('abort', pending.onAbort, { once: true });
    }
    if (input.trafficClass === 'interactive') pendingInteractiveRequests.push(pending);
    else pendingBackgroundRequests.push(pending);
    pumpEVaultTrafficRequests();
  });
}

/** Test helper; production code never clears the active traffic lane. */
export function resetEVaultTrafficGovernorForTests(): void {
  if (scheduledPump) clearTimeout(scheduledPump);
  scheduledPump = undefined;
  for (const active of activeBackgroundRequests) active.controller.abort();
  activeBackgroundRequests.clear();
  for (const pending of pendingInteractiveRequests) settlePending(pending, undefined);
  for (const pending of pendingBackgroundRequests) settlePending(pending, undefined);
  pendingInteractiveRequests = [];
  pendingBackgroundRequests = [];
  nextControlRequestAt = 0;
  nextBackgroundRequestAt = 0;
  interactiveControlBurstTokens = interactiveControlBurstSize;
  interactiveControlBurstRefilledAt = 0;
  interactiveTrafficSessions = 0;
}

function preemptBackgroundTraffic(): void {
  for (const active of activeBackgroundRequests) {
    active.controller.abort(interactiveTrafficPreemption);
  }
  for (const pending of pendingBackgroundRequests) settlePending(pending, undefined);
  pendingBackgroundRequests = [];
  pumpEVaultTrafficRequests();
}

function pumpEVaultTrafficRequests(now = Date.now()): void {
  if (scheduledPump) {
    clearTimeout(scheduledPump);
    scheduledPump = undefined;
  }
  discardAbortedPendingRequests();
  const pending =
    pendingInteractiveRequests[0] ??
    (interactiveTrafficSessions === 0 && activeBackgroundRequests.size === 0
      ? pendingBackgroundRequests[0]
      : undefined);
  if (!pending) return;
  const canUseInteractiveBurst =
    pending.trafficClass === 'interactive' &&
    interactiveTrafficSessions > 0 &&
    takeInteractiveControlBurstToken(now);
  const notBefore =
    canUseInteractiveBurst
      ? now
      : pending.trafficClass === 'background'
      ? Math.max(nextControlRequestAt, nextBackgroundRequestAt)
      : nextControlRequestAt;
  if (notBefore > now) {
    scheduledPump = setTimeout(() => {
      scheduledPump = undefined;
      pumpEVaultTrafficRequests();
    }, notBefore - now);
    scheduledPump.unref?.();
    return;
  }

  if (pending.trafficClass === 'interactive') pendingInteractiveRequests.shift();
  else pendingBackgroundRequests.shift();
  // A small foreground proof batch can spend already-accrued burst tokens,
  // but every later request still observes the normal cadence.
  nextControlRequestAt = Math.max(nextControlRequestAt, now + controlRequestSpacingMs);
  const controller = pending.trafficClass === 'background' ? new AbortController() : undefined;
  const active = controller ? { controller } : undefined;
  if (active) {
    activeBackgroundRequests.add(active);
    nextBackgroundRequestAt = now + backgroundRequestSpacingMs;
  }
  settlePending(pending, {
    signal: pending.signal
      ? AbortSignal.any(
          controller ? [pending.signal, controller.signal] : [pending.signal],
        )
      : controller?.signal ?? new AbortController().signal,
    release: () => {
      if (!active || !activeBackgroundRequests.delete(active)) return;
      pumpEVaultTrafficRequests();
    },
  });
  // A response may be slow, but the next request is allowed to start at the
  // next cadence slot. This preserves the File -> metadata compatibility
  // hedge while the background single-flight guard above prevents inventory
  // work from accumulating slow upstream sockets.
  pumpEVaultTrafficRequests();
}

function takeInteractiveControlBurstToken(now: number): boolean {
  const elapsed = Math.max(0, now - interactiveControlBurstRefilledAt);
  const replenished = Math.floor(elapsed / controlRequestSpacingMs);
  if (replenished > 0) {
    interactiveControlBurstTokens = Math.min(
      interactiveControlBurstSize,
      interactiveControlBurstTokens + replenished,
    );
    interactiveControlBurstRefilledAt += replenished * controlRequestSpacingMs;
  }
  if (interactiveControlBurstTokens < 1) return false;
  interactiveControlBurstTokens -= 1;
  return true;
}

function discardAbortedPendingRequests(): void {
  for (const pending of [...pendingInteractiveRequests, ...pendingBackgroundRequests]) {
    if (!pending.signal?.aborted) continue;
    removePendingRequest(pending);
    settlePending(pending, undefined);
  }
}

function removePendingRequest(pending: PendingEVaultRequest): void {
  const queue =
    pending.trafficClass === 'interactive' ? pendingInteractiveRequests : pendingBackgroundRequests;
  const index = queue.indexOf(pending);
  if (index >= 0) queue.splice(index, 1);
}

function settlePending(
  pending: PendingEVaultRequest,
  lease: EVaultTrafficLease | undefined,
): void {
  if (pending.onAbort && pending.signal)
    pending.signal.removeEventListener('abort', pending.onAbort);
  pending.resolve(lease);
}
