import { describe, expect, it } from 'vitest';
import { createExpiringMemoryCache } from './expiring-memory-cache';

describe('expiring memory cache', () => {
  it('returns a value only while it is fresh', () => {
    let time = 1_000;
    const cache = createExpiringMemoryCache<string>({ maxAgeMs: 120_000, now: () => time });

    cache.set('member', 'private library');
    time += 119_999;
    expect(cache.get('member')).toBe('private library');

    time += 1;
    expect(cache.get('member')).toBeUndefined();
  });

  it('keeps the cache bounded and clears a requested member', () => {
    const cache = createExpiringMemoryCache<number>({ maxAgeMs: 120_000, maxEntries: 2 });

    cache.set('first', 1);
    cache.set('second', 2);
    cache.set('third', 3);

    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('second')).toBe(2);
    cache.clear('second');
    expect(cache.get('second')).toBeUndefined();
    expect(cache.get('third')).toBe(3);
  });
});
