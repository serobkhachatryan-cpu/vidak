import { describe, expect, it } from 'vitest';
import { libraryPollingDelayMs } from './library-polling';
import { completeInventory } from './video-space-model';

describe('libraryPollingDelayMs', () => {
  it('uses low-frequency progress polls while an inventory scan is active', () => {
    expect(libraryPollingDelayMs({ discovery: 'refreshing' })).toBe(15_000);
  });

  it('backs off while background work is deferred or rate limited', () => {
    expect(
      libraryPollingDelayMs({
        discovery: 'refreshing',
        completeness: { ...completeInventory, retrying: 1 },
      }),
    ).toBe(20_000);
    expect(
      libraryPollingDelayMs({
        discovery: 'refreshing',
        completeness: { ...completeInventory, retryRateLimited: 1 },
      }),
    ).toBe(30_000);
  });

  it('stops automatic scans when a terminal partial result needs the visible Retry action', () => {
    expect(
      libraryPollingDelayMs({
        discovery: 'partial',
        completeness: { ...completeInventory, complete: false, retryNeeded: true },
      }),
    ).toBeUndefined();
    expect(
      libraryPollingDelayMs({
        discovery: 'partial',
        completeness: { ...completeInventory, complete: false, retrying: 1, deferred: 1 },
      }),
    ).toBeUndefined();
  });
});
