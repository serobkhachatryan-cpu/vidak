import { describe, expect, it } from 'vitest';
import { mapPool } from './map-pool';

describe('mapPool', () => {
  it('caps concurrency while preserving order', async () => {
    let running = 0;
    let max = 0;
    const result = await mapPool([1, 2, 3, 4], 2, async (value) => {
      running += 1;
      max = Math.max(max, running);
      await Promise.resolve();
      running -= 1;
      return value * 10;
    });
    expect(result).toEqual([10, 20, 30, 40]);
    expect(max).toBeLessThanOrEqual(2);
  });
});
