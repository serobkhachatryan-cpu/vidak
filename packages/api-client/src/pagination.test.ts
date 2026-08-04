import { describe, expect, it } from 'vitest';
import { createCursorPage, getNextPageParam } from './pagination';

describe('cursor pagination helpers', () => {
  it('creates consecutive pages without exposing collection internals', () => {
    const first = createCursorPage(['a', 'b', 'c'], { limit: 2 });
    const second = createCursorPage(['a', 'b', 'c'], {
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      limit: 2,
    });

    expect(first).toEqual({ items: ['a', 'b'], nextCursor: 'offset:2' });
    expect(second).toEqual({ items: ['c'] });
  });

  it('treats malformed cursors as the first page', () => {
    expect(createCursorPage(['a'], { cursor: 'not-a-cursor' })).toEqual({ items: ['a'] });
  });

  it('returns the page cursor in the format React Query expects', () => {
    expect(getNextPageParam({ items: [], nextCursor: 'offset:2' })).toBe('offset:2');
    expect(getNextPageParam({ items: [] })).toBeUndefined();
  });
});
