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

  it('removes one stale card without touching another account or sibling card', () => {
    const memory = createVideoSpaceLibraryMemory();
    const shared = {
      id: 'shared-stale',
      title: 'Shared cut',
      accessScope: 'shared' as const,
      visibility: 'shared-with-me' as const,
    };
    const personal = {
      id: 'personal-1',
      title: 'Mine',
      accessScope: 'personal' as const,
      visibility: 'private' as const,
    };
    memory.set('account-a', [shared, personal]);
    memory.set('account-b', [shared]);

    memory.remove('account-a', shared.id);

    expect(memory.get('account-a', shared.id)).toBeUndefined();
    expect(memory.get('account-a', personal.id)).toEqual(personal);
    expect(memory.get('account-b', shared.id)).toEqual(shared);
  });
});
