import { describe, expect, it } from 'vitest';
import { createVideoSpaceLibraryMemory } from './video-space-library-memory';

describe('video space library memory', () => {
  it('returns a private in-memory copy only to the account that loaded it', () => {
    const memory = createVideoSpaceLibraryMemory();
    const items = [
      {
        id: 'shared-1',
        title: 'Shared cut',
        accessScope: 'shared' as const,
        visibility: 'shared-with-me' as const,
        streamIds: ['viewer-bound-stream'],
      },
    ];

    memory.set('account-a', items);
    items[0]?.streamIds?.push('mutated-after-cache');

    expect(memory.get('account-a', 'shared-1')).toEqual({
      ...items[0],
      streamIds: ['viewer-bound-stream'],
    });
    expect(memory.get('account-b', 'shared-1')).toBeUndefined();
  });

  it('expires a cached card instead of retaining private library data', () => {
    let now = 1_000;
    const memory = createVideoSpaceLibraryMemory({ now: () => now });
    memory.set('account-a', [
      {
        id: 'personal-1',
        title: 'Private cut',
        accessScope: 'personal',
        visibility: 'private',
      },
    ]);

    now += 2 * 60 * 1_000;

    expect(memory.get('account-a', 'personal-1')).toBeUndefined();
  });
});
