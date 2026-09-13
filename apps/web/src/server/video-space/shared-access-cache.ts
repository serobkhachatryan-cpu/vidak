import 'server-only';

import type { SharedSpaceAccess, SharedSpaceProbe } from '../meshenger-video-library';

// Native media players issue bursts of independent Range requests. Retain a
// positive source check long enough to keep one viewing session smooth, while
// still re-evaluating a changed W3DS policy within one minute.
const verifiedAccessTtlMs = 60_000;
const maxVerifiedAccessEntries = 512;

interface VerifiedAccess {
  expiresAt: number;
  revision: number;
}

/**
 * A catalogue recheck is cancellable background work. It must never become
 * the pending operation that an interactive playback authorization inherits.
 * Positive completed proofs remain shared across both scopes.
 */
export type SharedAccessProbePriority = 'background' | 'warmup' | 'interactive';

const verifiedAccess = new Map<string, VerifiedAccess>();
const inflightProbes = new Map<string, Promise<SharedSpaceAccess>>();
// A rejected media URL can be evidence that the source's membership changed
// while a slow proof was still in flight. A revision makes that invalidation
// linearizable: an earlier proof may finish for its original caller, but it
// cannot repopulate the short-lived positive cache or be joined by the retry.
const accessRevisions = new Map<string, number>();

/**
 * Reuses a successful shared-source check across the catalogue and the media
 * route. The key includes the viewer and exact authorization evidence; only
 * positive checks are retained, and only for a short interactive window.
 */
export async function coalesceSharedAccessProbe(
  viewerEName: string,
  source: SharedSpaceProbe,
  probe: () => Promise<SharedSpaceAccess>,
  now = Date.now(),
  completedAt: () => number = Date.now,
  options?: { priority?: SharedAccessProbePriority; bypassVerifiedAccess?: boolean },
): Promise<SharedSpaceAccess> {
  const cacheKey = sharedAccessCacheKey(viewerEName, source);
  const revision = sharedAccessRevision(cacheKey);
  // Source recovery can deliberately require a new current proof before it
  // is allowed to invalidate a cached private URL. It still joins an already
  // in-flight probe with the same revision/priority, so this does not turn a
  // burst of recovery attempts into duplicate remote reads.
  if (!options?.bypassVerifiedAccess && hasVerifiedSharedAccess(viewerEName, source, now)) {
    return { access: 'ok', member: true };
  }
  const key = inflightProbeKey(viewerEName, source, options?.priority ?? 'interactive', revision);
  const inflight = inflightProbes.get(key);
  if (inflight) return inflight;

  const pending = probe()
    .then((access) => {
      if (access.access === 'ok' && access.member) {
        // Start the short reuse window when a potentially slow source check
        // actually succeeds. Using the request's start time can leave almost
        // no cache lifetime after a long eVault authorization read.
        rememberVerifiedSharedAccess(viewerEName, source, completedAt(), { revision });
      }
      return access;
    })
    .finally(() => {
      inflightProbes.delete(key);
    });
  inflightProbes.set(key, pending);
  return pending;
}

export function hasVerifiedSharedAccess(
  viewerEName: string,
  source: SharedSpaceProbe,
  now = Date.now(),
): boolean {
  const key = sharedAccessCacheKey(viewerEName, source);
  const cached = verifiedAccess.get(key);
  if (!cached) return false;
  if (cached.revision === sharedAccessRevision(key) && cached.expiresAt > now) return true;
  verifiedAccess.delete(key);
  return false;
}

export function rememberVerifiedSharedAccess(
  viewerEName: string,
  source: SharedSpaceProbe,
  now = Date.now(),
  options?: { revision?: number },
): boolean {
  const key = sharedAccessCacheKey(viewerEName, source);
  const revision = sharedAccessRevision(key);
  // Callers that did not capture a proof revision are catalogue shortcuts,
  // not a retry's authoritative source check. Once a source has explicitly
  // invalidated access, let only a newly coalesced proof warm it again.
  if (
    (options?.revision === undefined && revision !== 0) ||
    (options?.revision !== undefined && options.revision !== revision)
  ) {
    return false;
  }
  for (const [key, cached] of verifiedAccess) {
    if (cached.expiresAt <= now || verifiedAccess.size >= maxVerifiedAccessEntries) {
      verifiedAccess.delete(key);
    }
  }
  verifiedAccess.set(key, {
    expiresAt: now + verifiedAccessTtlMs,
    revision,
  });
  return true;
}

/**
 * Rejects a completed positive proof and makes any earlier in-flight proof
 * ineligible to warm the cache. This is intentionally stronger than merely
 * deleting the completed entry.
 */
export function invalidateVerifiedSharedAccess(
  viewerEName: string,
  source: SharedSpaceProbe,
): void {
  const key = sharedAccessCacheKey(viewerEName, source);
  accessRevisions.set(key, advanceRevision(sharedAccessRevision(key)));
  verifiedAccess.delete(key);
}

/** Test helper; production code never clears authorization state globally. */
export function resetSharedAccessCacheForTests(): void {
  verifiedAccess.clear();
  inflightProbes.clear();
  accessRevisions.clear();
}

function sharedAccessCacheKey(viewerEName: string, source: SharedSpaceProbe): string {
  return `${normalizeEName(viewerEName)}\u0000${source.kind}\u0000${normalizeEName(
    source.eName,
  )}\u0000${source.kind === 'direct' ? source.chatId : ''}\u0000${
    source.kind === 'reference' ? source.referenceId : ''
  }\u0000${source.kind === 'reference' ? source.fileId : ''}`;
}

function inflightProbeKey(
  viewerEName: string,
  source: SharedSpaceProbe,
  priority: SharedAccessProbePriority,
  revision: number,
): string {
  return `${sharedAccessCacheKey(viewerEName, source)}\u0000revision:${revision}\u0000${priority}`;
}

function sharedAccessRevision(key: string): number {
  return accessRevisions.get(key) ?? 0;
}

function advanceRevision(current: number): number {
  return current < Number.MAX_SAFE_INTEGER ? current + 1 : 1;
}

function normalizeEName(value: string): string {
  return value.trim().toLowerCase();
}
