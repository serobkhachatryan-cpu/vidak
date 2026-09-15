/**
 * A shared video needs one private eVault authorization resolution before the
 * browser can request its first media range. Begin it on an explicit watch
 * gesture or after a brief hover/focus dwell, so a large grid never competes
 * with the video the viewer actually chose. The endpoint never returns the
 * redirect or downloads media bytes in this request.
 *
 * This queue is deliberately small. A likely Watch action gets a modest head
 * start, while moving through a large grid never turns into a burst of
 * requests against somebody else's eVault.
 */
// A completed client hint must expire before the server's short shared-access
// proof. Otherwise a click can skip this warmup after the server proof has
// expired, leaving the player to perform a cold remote authorization.
const completedWarmupTtlMs = 45_000;
const warmupIntentDelayMs = 400;

type WarmupIntent = 'hover' | 'watch';

interface WarmupEntry {
  url: string;
  intent: WarmupIntent;
  hoverId?: number;
}

interface ActiveWarmup {
  entry: WarmupEntry;
  controller?: AbortController;
}

interface ScheduledWarmup {
  timer: ReturnType<typeof setTimeout>;
}

let queuedWarmup: WarmupEntry | undefined;
const completedWarmups = new Map<string, number>();
const scheduledWarmups = new Map<string, ScheduledWarmup>();
let activeWarmup: ActiveWarmup | undefined;
let nextHoverId = 0;

/**
 * Resolves a private source redirect without exposing it or preloading media.
 * Explicit clicks use `keepalive` so they can finish after the grid route is
 * replaced; dwell-based hovers are deliberately cancellable instead.
 */
export function warmSharedVideoAuthorization(url: string): void {
  pruneCompletedWarmups();
  cancelScheduledWarmup(url);
  if (completedWarmups.has(url)) return;
  if (activeWarmup?.entry.url === url) {
    if (activeWarmup.entry.intent === 'watch') return;
    // A hover uses an isolated cancellable server key so it can never poison
    // an interactive player request. Replace it with one keepalive Watch
    // authorization; the player can share that interactive pending work.
    abortActiveHover();
  }
  if (queuedWarmup?.url === url) {
    queuedWarmup.intent = 'watch';
    delete queuedWarmup.hoverId;
    return;
  }

  // A hover is only a best-effort hint. Stop it before making an explicitly
  // requested Watch wait behind a source the viewer has already left.
  abortActiveHover();
  queuedWarmup = { url, intent: 'watch' };
  drainWarmups();
}

/**
 * Starts a source authorization only after a short dwell on a playable card.
 * The returned cleanup cancels the intent on pointer leave, blur, or unmount.
 * A direct pointer-down/click still calls `warmSharedVideoAuthorization`
 * immediately and takes priority over this best-effort hint.
 */
export function scheduleSharedVideoAuthorizationWarmup(url: string): () => void {
  pruneCompletedWarmups();
  if (completedWarmups.has(url) || activeWarmup?.entry.url === url || queuedWarmup?.url === url) {
    return () => undefined;
  }
  cancelScheduledWarmup(url);
  const id = ++nextHoverId;
  const scheduled: ScheduledWarmup = {
    timer: setTimeout(() => {
      if (scheduledWarmups.get(url) !== scheduled) return;
      scheduledWarmups.delete(url);
      enqueueWarmup({ url, intent: 'hover', hoverId: id });
    }, warmupIntentDelayMs),
  };
  scheduledWarmups.set(url, scheduled);
  return () => {
    if (scheduledWarmups.get(url) === scheduled) {
      clearTimeout(scheduled.timer);
      scheduledWarmups.delete(url);
    }
    cancelQueuedHover(url, id);
    if (cancelActiveHover(url, id)) drainWarmups();
  };
}

/**
 * Stops only speculative hover/focus work from any card. A newly selected
 * continuous recording uses its own opaque ticket as the one authoritative
 * source-zero authorization path, so an older hover must not compete with it.
 * Deliberate click/watch work is intentionally retained: it represents a
 * separate confirmed user action and may safely finish after navigation.
 */
export function cancelCancellableSharedVideoAuthorizationHoverWork(): void {
  for (const scheduled of scheduledWarmups.values()) clearTimeout(scheduled.timer);
  scheduledWarmups.clear();
  if (queuedWarmup?.intent === 'hover') queuedWarmup = undefined;
  cancelActiveHover();
  // If a confirmed Watch was queued while a hover was in flight, keep it
  // moving. This helper only removes the low-priority speculative entries.
  drainWarmups();
}

function enqueueWarmup(entry: WarmupEntry): void {
  if (completedWarmups.has(entry.url) || activeWarmup?.entry.url === entry.url) return;
  if (queuedWarmup?.url === entry.url) return;
  // A queued explicit click represents a stronger, newer intent than a
  // background hover. Do not replace it with speculative work.
  if (entry.intent === 'hover' && queuedWarmup?.intent === 'watch') return;
  queuedWarmup = entry;
  drainWarmups();
}

function cancelQueuedHover(url: string, hoverId: number): void {
  if (
    queuedWarmup?.intent === 'hover' &&
    queuedWarmup.url === url &&
    queuedWarmup.hoverId === hoverId
  ) {
    queuedWarmup = undefined;
  }
}

function cancelActiveHover(url?: string, hoverId?: number): boolean {
  const active = activeWarmup;
  if (active?.entry.intent !== 'hover') return false;
  if (url !== undefined && active.entry.url !== url) return false;
  if (hoverId !== undefined && active.entry.hoverId !== hoverId) return false;
  // A browser normally rejects fetch immediately on abort. Clear the slot
  // before that promise settles too, so an explicit Watch never waits behind
  // a non-compliant fetch implementation or a delayed rejection callback.
  activeWarmup = undefined;
  active.controller?.abort();
  return true;
}

function abortActiveHover(): void {
  cancelActiveHover();
}

function drainWarmups(): void {
  while (!activeWarmup && queuedWarmup) {
    const entry = queuedWarmup;
    queuedWarmup = undefined;
    if (completedWarmups.has(entry.url)) continue;
    const controller = entry.intent === 'hover' ? new AbortController() : undefined;
    const active: ActiveWarmup = { entry, ...(controller ? { controller } : {}) };
    activeWarmup = active;
    const requestUrl = entry.intent === 'hover' ? hoverWarmupUrl(entry.url) : entry.url;
    void fetch(requestUrl, {
      cache: 'no-store',
      credentials: 'same-origin',
      // A deliberate click survives the client-side route transition. A
      // hover is intentionally cancellable, so an abandoned card cannot
      // keep retrying an eVault while the viewer opens another video.
      ...(entry.intent === 'watch'
        ? { keepalive: true }
        : controller
          ? { signal: controller.signal }
          : {}),
    })
      .then((response) => {
        if (!response.ok) throw new Error('Shared video authorization warmup failed.');
        completedWarmups.set(entry.url, Date.now() + completedWarmupTtlMs);
      })
      .catch(() => {
        // Do not pin a transient failure. A later watch gesture or the media
        // route can safely retry the source authorization.
      })
      .finally(() => {
        if (activeWarmup === active) activeWarmup = undefined;
        drainWarmups();
      });
  }
}

function hoverWarmupUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}priority=warmup`;
}

function pruneCompletedWarmups(now = Date.now()): void {
  for (const [url, expiresAt] of completedWarmups) {
    if (expiresAt <= now) completedWarmups.delete(url);
  }
}

function cancelScheduledWarmup(url: string): void {
  const scheduled = scheduledWarmups.get(url);
  if (!scheduled) return;
  clearTimeout(scheduled.timer);
  scheduledWarmups.delete(url);
}

export function resetSharedVideoAuthorizationWarmupsForTests(): void {
  activeWarmup?.controller?.abort();
  queuedWarmup = undefined;
  completedWarmups.clear();
  for (const scheduled of scheduledWarmups.values()) clearTimeout(scheduled.timer);
  scheduledWarmups.clear();
  activeWarmup = undefined;
  nextHoverId = 0;
}
