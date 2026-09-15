import 'server-only';

import type { SharedSpaceAccess } from '../meshenger-video-library';
import type { SharedAccessProbePriority } from './shared-access-cache';

// A group CallSession participant proof is deliberately kept outside the
// group-membership cache. Group membership is broad and mutable; this proof
// instead names one current CallSession and one exact canonical File URI.
const verifiedAccessTtlMs = 60_000;
const maxVerifiedAccessEntries = 512;

export interface GroupCallAccessProof {
  /** Signed group source context; may differ from the CallSession vault. */
  sourceSpaceKey: string;
  callSessionVault: string;
  callSessionId: string;
  chatId: string;
  fileUri: string;
  recordingVault?: string;
}

interface VerifiedAccess {
  expiresAt: number;
  revision: number;
}

const verifiedAccess = new Map<string, VerifiedAccess>();
const inflightProbes = new Map<string, Promise<SharedSpaceAccess>>();
const accessRevisions = new Map<string, number>();

/**
 * Coalesces only the same viewer + exact group CallSession + exact File proof.
 * In particular, a completed proof for one recording segment cannot authorize
 * a later segment merely because both appeared in the same group call.
 */
export async function coalesceGroupCallAccessProof(
  viewerEName: string,
  source: GroupCallAccessProof,
  probe: () => Promise<SharedSpaceAccess>,
  now = Date.now(),
  completedAt: () => number = Date.now,
  options?: { priority?: SharedAccessProbePriority; bypassVerifiedAccess?: boolean },
): Promise<SharedSpaceAccess> {
  const cacheKey = groupCallAccessCacheKey(viewerEName, source);
  const revision = accessRevision(cacheKey);
  if (!options?.bypassVerifiedAccess && hasVerifiedGroupCallAccess(viewerEName, source, now)) {
    return { access: 'ok', member: true };
  }
  const key = inflightProbeKey(viewerEName, source, options?.priority ?? 'interactive', revision);
  const inflight = inflightProbes.get(key);
  if (inflight) return inflight;

  const pending = probe()
    .then((access) => {
      if (access.access === 'ok' && access.member) {
        rememberVerifiedGroupCallAccess(viewerEName, source, completedAt(), { revision });
      }
      return access;
    })
    .finally(() => {
      inflightProbes.delete(key);
    });
  inflightProbes.set(key, pending);
  return pending;
}

export function hasVerifiedGroupCallAccess(
  viewerEName: string,
  source: GroupCallAccessProof,
  now = Date.now(),
): boolean {
  const key = groupCallAccessCacheKey(viewerEName, source);
  const cached = verifiedAccess.get(key);
  if (!cached) return false;
  if (cached.revision === accessRevision(key) && cached.expiresAt > now) return true;
  verifiedAccess.delete(key);
  return false;
}

export function invalidateVerifiedGroupCallAccess(
  viewerEName: string,
  source: GroupCallAccessProof,
): void {
  const key = groupCallAccessCacheKey(viewerEName, source);
  accessRevisions.set(key, advanceRevision(accessRevision(key)));
  verifiedAccess.delete(key);
}

function rememberVerifiedGroupCallAccess(
  viewerEName: string,
  source: GroupCallAccessProof,
  now: number,
  options: { revision: number },
): boolean {
  const key = groupCallAccessCacheKey(viewerEName, source);
  const revision = accessRevision(key);
  if (options.revision !== revision) return false;
  for (const [cachedKey, cached] of verifiedAccess) {
    if (cached.expiresAt <= now || verifiedAccess.size >= maxVerifiedAccessEntries) {
      verifiedAccess.delete(cachedKey);
    }
  }
  verifiedAccess.set(key, { expiresAt: now + verifiedAccessTtlMs, revision });
  return true;
}

/** Test helper; production entries expire and are never globally reset. */
export function resetGroupCallAccessCacheForTests(): void {
  verifiedAccess.clear();
  inflightProbes.clear();
  accessRevisions.clear();
}

function groupCallAccessCacheKey(viewerEName: string, source: GroupCallAccessProof): string {
  return [
    normalizeEName(viewerEName),
    'group-call',
    normalizeEName(source.sourceSpaceKey),
    normalizeEName(source.callSessionVault),
    source.callSessionId,
    source.chatId,
    source.recordingVault ? normalizeEName(source.recordingVault) : '',
    source.fileUri,
  ].join('\u0000');
}

function inflightProbeKey(
  viewerEName: string,
  source: GroupCallAccessProof,
  priority: SharedAccessProbePriority,
  revision: number,
): string {
  return `${groupCallAccessCacheKey(viewerEName, source)}\u0000revision:${revision}\u0000${priority}`;
}

function accessRevision(key: string): number {
  return accessRevisions.get(key) ?? 0;
}

function advanceRevision(current: number): number {
  return current < Number.MAX_SAFE_INTEGER ? current + 1 : 1;
}

function normalizeEName(value: string): string {
  return value.trim().toLowerCase();
}
