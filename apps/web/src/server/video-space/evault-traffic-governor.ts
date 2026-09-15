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

const backgroundRequestSpacingMs = 1_000;

interface ActiveBackgroundRequest {
  controller: AbortController;
}

interface PendingBackgroundRequest {
  signal?: AbortSignal;
  resolve: (lease: EVaultTrafficLease | undefined) => void;
  onAbort?: () => void;
}

let activeBackgroundRequest: ActiveBackgroundRequest | undefined;
let pendingBackgroundRequests: PendingBackgroundRequest[] = [];
let nextBackgroundRequestAt = 0;
let scheduledPump: ReturnType<typeof setTimeout> | undefined;
let interactiveTrafficSessions = 0;
const interactiveTrafficPreemption = Symbol('interactive-eVault-traffic-preemption');

/** True only when a foreground Watch deliberately displaced this request. */
export function isEVaultTrafficPreempted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === interactiveTrafficPreemption;
}

/**
 * Starts a transaction-wide foreground reservation. Individual interactive
 * eVault requests still acquire immediately, but background work cannot slip
 * between two proof/File requests belonging to the same Watch action.
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
      if (interactiveTrafficSessions === 0) pumpBackgroundRequests();
    },
  };
}

/**
 * Acquires one outbound eVault request lease. A missing lease means the
 * cancellable background caller was preempted and must yield its durable work.
 * It never represents an authorization outcome.
 */
export function acquireEVaultTrafficLease(input: {
  trafficClass: EVaultTrafficClass;
  signal?: AbortSignal;
}): Promise<EVaultTrafficLease | undefined> {
  if (input.trafficClass === 'interactive') {
    preemptBackgroundTraffic();
    return Promise.resolve({
      signal: input.signal ?? new AbortController().signal,
      release: () => undefined,
    });
  }
  if (input.signal?.aborted) return Promise.resolve(undefined);

  return new Promise<EVaultTrafficLease | undefined>((resolve) => {
    const pending: PendingBackgroundRequest = input.signal
      ? { signal: input.signal, resolve }
      : { resolve };
    if (input.signal) {
      pending.onAbort = () => {
        removePendingRequest(pending);
        resolve(undefined);
      };
      input.signal.addEventListener('abort', pending.onAbort, { once: true });
    }
    pendingBackgroundRequests.push(pending);
    pumpBackgroundRequests();
  });
}

/** Test helper; production code never clears the active traffic lane. */
export function resetEVaultTrafficGovernorForTests(): void {
  if (scheduledPump) clearTimeout(scheduledPump);
  scheduledPump = undefined;
  activeBackgroundRequest?.controller.abort();
  activeBackgroundRequest = undefined;
  for (const pending of pendingBackgroundRequests) settlePending(pending, undefined);
  pendingBackgroundRequests = [];
  nextBackgroundRequestAt = 0;
  interactiveTrafficSessions = 0;
}

function preemptBackgroundTraffic(): void {
  activeBackgroundRequest?.controller.abort(interactiveTrafficPreemption);
  for (const pending of pendingBackgroundRequests) settlePending(pending, undefined);
  pendingBackgroundRequests = [];
  if (scheduledPump) {
    clearTimeout(scheduledPump);
    scheduledPump = undefined;
  }
}

function pumpBackgroundRequests(now = Date.now()): void {
  if (scheduledPump) {
    clearTimeout(scheduledPump);
    scheduledPump = undefined;
  }
  discardAbortedPendingRequests();
  if (
    activeBackgroundRequest ||
    interactiveTrafficSessions > 0 ||
    pendingBackgroundRequests.length === 0
  ) {
    return;
  }

  const notBefore = nextBackgroundRequestAt;
  if (notBefore > now) {
    scheduledPump = setTimeout(() => {
      scheduledPump = undefined;
      pumpBackgroundRequests();
    }, notBefore - now);
    scheduledPump.unref?.();
    return;
  }

  const pending = pendingBackgroundRequests.shift();
  if (!pending) return;
  const controller = new AbortController();
  const active: ActiveBackgroundRequest = { controller };
  activeBackgroundRequest = active;
  nextBackgroundRequestAt = now + backgroundRequestSpacingMs;
  settlePending(pending, {
    signal: pending.signal
      ? AbortSignal.any([pending.signal, controller.signal])
      : controller.signal,
    release: () => {
      if (activeBackgroundRequest !== active) return;
      activeBackgroundRequest = undefined;
      pumpBackgroundRequests();
    },
  });
}

function discardAbortedPendingRequests(): void {
  for (const pending of [...pendingBackgroundRequests]) {
    if (!pending.signal?.aborted) continue;
    removePendingRequest(pending);
    settlePending(pending, undefined);
  }
}

function removePendingRequest(pending: PendingBackgroundRequest): void {
  const index = pendingBackgroundRequests.indexOf(pending);
  if (index >= 0) pendingBackgroundRequests.splice(index, 1);
}

function settlePending(
  pending: PendingBackgroundRequest,
  lease: EVaultTrafficLease | undefined,
): void {
  if (pending.onAbort && pending.signal)
    pending.signal.removeEventListener('abort', pending.onAbort);
  pending.resolve(lease);
}
