import { describe, expect, it, vi } from 'vitest';
import {
  nextBackoffMs,
  parseRetryAfter,
  retryDelayMs,
  retryWithExponentialBackoff,
} from './backoff';

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

  it('parses Retry-After seconds and HTTP-date, and waits at least that long', async () => {
    expect(parseRetryAfter('2')).toBe(2_000);
    expect(parseRetryAfter('0')).toBe(0);
    const date = new Date(Date.now() + 5_000).toUTCString();
    expect(parseRetryAfter(date) ?? 0).toBeGreaterThanOrEqual(4_000);
    expect(retryDelayMs({ attempt: 1, retryAfterMs: 0 })).toBe(0);
    expect(retryDelayMs({ attempt: 1, retryAfterMs: 8_000 })).toBe(8_000);
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    await retryWithExponentialBackoff(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = Object.assign(new Error('429'), { retryAfterMs: 1_500 });
          throw error;
        }
        return 'ok';
      },
      {
        isRetryable: () => true,
        sleep,
        maxAttempts: 3,
        retryAfterMs: (error) => (error as { retryAfterMs?: number }).retryAfterMs,
      },
    );
    expect(sleep).toHaveBeenCalledWith(1_500);
  });
});
