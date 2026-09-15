import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { MeshengerVideoLibraryError } from '../meshenger-video-library';
import {
  confirmedSharedPlaybackCardBindingHash,
  InMemorySharedPlaybackCardQuarantineStore,
} from './shared-playback-card-quarantine';

describe('shared playback card quarantine', () => {
  it('keeps a confirmed opaque card binding only until its bounded expiry', async () => {
    let now = 1_000;
    const bindingHash = 'a'.repeat(43);
    const store = new InMemorySharedPlaybackCardQuarantineStore({
      now: () => now,
      ttlMs: 500,
    });

    await store.record(bindingHash);

    await expect(store.matching([bindingHash, 'not-a-binding'])).resolves.toEqual(
      new Set([bindingHash]),
    );
    now += 500;
    await expect(store.matching([bindingHash])).resolves.toEqual(new Set());
  });

  it('accepts only the private terminal marker, never a public authorization code alone', () => {
    const bindingHash = 'b'.repeat(43);
    const terminal = new MeshengerVideoLibraryError(
      'Access was revoked.',
      'authorization_denied',
      403,
      undefined,
      bindingHash,
    );
    const generic = new MeshengerVideoLibraryError(
      'The upstream denied a request.',
      'authorization_denied',
      403,
    );

    expect(confirmedSharedPlaybackCardBindingHash(terminal)).toBe(bindingHash);
    expect(confirmedSharedPlaybackCardBindingHash(generic)).toBeUndefined();
    expect(
      confirmedSharedPlaybackCardBindingHash({ code: 'authorization_denied' }),
    ).toBeUndefined();
  });
});
