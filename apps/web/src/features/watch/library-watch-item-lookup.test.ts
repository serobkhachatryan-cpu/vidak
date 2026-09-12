import { describe, expect, it } from 'vitest';
import { libraryWatchItemLookupPath } from './library-watch-item-lookup';

describe('libraryWatchItemLookupPath', () => {
  it('uses an exact encoded itemId rather than reloading the full library endpoint', () => {
    expect(libraryWatchItemLookupPath('w3ds-file:@owner.w3id/call recording?1')).toBe(
      '/api/evault/videos?scope=all&itemId=w3ds-file%3A%40owner.w3id%2Fcall+recording%3F1',
    );
  });
});
