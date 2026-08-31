import { describe, expect, it, vi } from 'vitest';
import { nextBackoffMs, retryWithExponentialBackoff } from './backoff';

describe('exponential 429 backoff', () => {
  it('doubles the delay and stops after a successful attempt', async () => {
    expect(nextBackoffMs(1)).toBe(250);
    expect(nextBackoffMs(2)).toBe(500);
    expect(nextBackoffMs(3)).toBe(1000);
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    const value = await retryWithExponentialBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('429');
        return 'ok';
      },
      { isRetryable: () => true, sleep, maxAttempts: 4 },
    );
    expect(value).toBe('ok');
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });
});
