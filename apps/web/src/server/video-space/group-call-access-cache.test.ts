import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  coalesceGroupCallAccessProof,
  type GroupCallAccessProof,
  hasVerifiedGroupCallAccess,
  invalidateVerifiedGroupCallAccess,
  resetGroupCallAccessCacheForTests,
} from './group-call-access-cache';

const viewer = '@viewer.w3id';
const proof: GroupCallAccessProof = {
  sourceSpaceKey: '@group.w3id',
  callSessionVault: '@calls.w3id',
  callSessionId: 'call-1',
  chatId: 'chat-1',
  recordingVault: '@media.w3id',
  fileUri: 'w3ds://file?id=@media.w3id/segment-a',
};

describe('group CallSession access cache', () => {
  afterEach(() => {
    resetGroupCallAccessCacheForTests();
  });

  it('never reuses an exact group call proof across another source context or File', async () => {
    const firstProbe = vi.fn(async () => ({ access: 'ok' as const, member: true }));

    await expect(coalesceGroupCallAccessProof(viewer, proof, firstProbe)).resolves.toEqual({
      access: 'ok',
      member: true,
    });
    expect(firstProbe).toHaveBeenCalledOnce();
    expect(hasVerifiedGroupCallAccess(viewer, proof)).toBe(true);

    const distinctProofs: GroupCallAccessProof[] = [
      { ...proof, sourceSpaceKey: '@different-group.w3id' },
      { ...proof, callSessionVault: '@different-calls.w3id' },
      { ...proof, callSessionId: 'call-2' },
      { ...proof, chatId: 'chat-2' },
      { ...proof, recordingVault: '@different-media.w3id' },
      { ...proof, fileUri: 'w3ds://file?id=@media.w3id/segment-b' },
    ];
    for (const distinctProof of distinctProofs) {
      const probe = vi.fn(async () => ({ access: 'denied' as const, member: false }));
      await expect(coalesceGroupCallAccessProof(viewer, distinctProof, probe)).resolves.toEqual({
        access: 'denied',
        member: false,
      });
      expect(probe).toHaveBeenCalledOnce();
      expect(hasVerifiedGroupCallAccess(viewer, distinctProof)).toBe(false);
    }

    const otherViewerProbe = vi.fn(async () => ({ access: 'denied' as const, member: false }));
    await expect(
      coalesceGroupCallAccessProof('@other-viewer.w3id', proof, otherViewerProbe),
    ).resolves.toEqual({ access: 'denied', member: false });
    expect(otherViewerProbe).toHaveBeenCalledOnce();
  });

  it('does not let a pre-invalidation in-flight result restore the exact File proof', async () => {
    let release: ((value: { access: 'ok'; member: true }) => void) | undefined;
    const pending = new Promise<{ access: 'ok'; member: true }>((resolve) => {
      release = resolve;
    });

    const first = coalesceGroupCallAccessProof(viewer, proof, () => pending);
    invalidateVerifiedGroupCallAccess(viewer, proof);
    release?.({ access: 'ok', member: true });

    await expect(first).resolves.toEqual({ access: 'ok', member: true });
    expect(hasVerifiedGroupCallAccess(viewer, proof)).toBe(false);
  });
});
