import 'server-only';

import type { SharedSpaceAccess, SharedSpaceProbe } from '../meshenger-video-library';

const verifiedAccessTtlMs = 15_000;
const maxVerifiedAccessEntries = 512;

interface VerifiedAccess {
  expiresAt: number;
}

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
): Promise<SharedSpaceAccess> {
  if (hasVerifiedSharedAccess(viewerEName, source, now)) {
    return { access: 'ok', member: true };
  }
  const key = sharedAccessCacheKey(viewerEName, source);
  const inflight = inflightProbes.get(key);
  if (inflight) return inflight;

  const pending = probe()
    .then((access) => {
      if (access.access === 'ok' && access.member) {
        rememberVerifiedSharedAccess(viewerEName, source, now);
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

function normalizeEName(value: string): string {
  return value.trim().toLowerCase();
}
