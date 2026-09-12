import 'server-only';

import type { SharedSpaceAccess, SharedSpaceProbe } from '../meshenger-video-library';

// Native media players issue bursts of independent Range requests. Retain a
// positive source check long enough to keep one viewing session smooth, while
// still re-evaluating a changed W3DS policy within one minute.
const verifiedAccessTtlMs = 60_000;
const maxVerifiedAccessEntries = 512;

interface VerifiedAccess {
  expiresAt: number;
}

/**
 * A catalogue recheck is cancellable background work. It must never become
 * the pending operation that an interactive playback authorization inherits.
 * Positive completed proofs remain shared across both scopes.
 */
export type SharedAccessProbePriority = 'background' | 'warmup' | 'interactive';

const verifiedAccess = new Map<string, VerifiedAccess>();
const inflightProbes = new Map<string, Promise<SharedSpaceAccess>>();

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
  options?: { priority?: SharedAccessProbePriority },
): Promise<SharedSpaceAccess> {
  if (hasVerifiedSharedAccess(viewerEName, source, now)) {
    return { access: 'ok', member: true };
  }
  const key = inflightProbeKey(viewerEName, source, options?.priority ?? 'interactive');
  const inflight = inflightProbes.get(key);
  if (inflight) return inflight;

  const pending = probe()
    .then((access) => {
      if (access.access === 'ok' && access.member) {
        // Start the short reuse window when a potentially slow source check
        // actually succeeds. Using the request's start time can leave almost
        // no cache lifetime after a long eVault authorization read.
        rememberVerifiedSharedAccess(viewerEName, source, completedAt());
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
  if (cached.expiresAt > now) return true;
  verifiedAccess.delete(key);
  return false;
}

export function rememberVerifiedSharedAccess(
  viewerEName: string,
  source: SharedSpaceProbe,
  now = Date.now(),
): void {
  for (const [key, cached] of verifiedAccess) {
    if (cached.expiresAt <= now || verifiedAccess.size >= maxVerifiedAccessEntries) {
      verifiedAccess.delete(key);
    }
  }
  verifiedAccess.set(sharedAccessCacheKey(viewerEName, source), {
    expiresAt: now + verifiedAccessTtlMs,
  });
}

export function forgetVerifiedSharedAccess(viewerEName: string, source: SharedSpaceProbe): void {
  verifiedAccess.delete(sharedAccessCacheKey(viewerEName, source));
}

/** Test helper; production code never clears authorization state globally. */
export function resetSharedAccessCacheForTests(): void {
  verifiedAccess.clear();
  inflightProbes.clear();
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
): string {
  return `${sharedAccessCacheKey(viewerEName, source)}\u0000${priority}`;
}

function normalizeEName(value: string): string {
  return value.trim().toLowerCase();
}
