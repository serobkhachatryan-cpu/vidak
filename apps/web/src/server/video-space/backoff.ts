/**
 * Exponential backoff for background 429 retries. Never used to stretch the
 * interactive HTTP request — fail-fast there, retry here.
 *
 * When the origin sends Retry-After, wait at least that long before the next
 * attempt so retries do not immediately re-trigger the limiter.
 */
export function nextBackoffMs(attempt: number, baseMs = 250, capMs = 30_000): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(capMs, baseMs * 2 ** exp);
}

/** Parses documented Retry-After: delay-seconds or HTTP-date. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(120_000, seconds * 1000);
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  const waitMs = timestamp - now;
  if (waitMs <= 0) return undefined;
  return Math.min(120_000, waitMs);
}

export function retryDelayMs(input: {
  attempt: number;
  retryAfterMs?: number;
  baseMs?: number;
  capMs?: number;
  jitterRatio?: number;
  random?: () => number;
}): number {
  if (input.retryAfterMs === 0) return 0;
  const exponential = nextBackoffMs(input.attempt, input.baseMs, input.capMs);
  const base = Math.max(exponential, input.retryAfterMs ?? 0);
  const jitterRatio = input.jitterRatio ?? 0.1;
  if (jitterRatio <= 0) return base;
  const random = input.random ?? Math.random;
  const jitter = Math.floor(base * jitterRatio * random());
  return base + jitter;
}

export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: {
    isRetryable: (error: unknown) => boolean;
    maxAttempts?: number;
    baseMs?: number;
    capMs?: number;
    jitterRatio?: number;
    random?: () => number;
    retryAfterMs?: (error: unknown) => number | undefined;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseMs = options.baseMs ?? 250;
  const capMs = options.capMs ?? 30_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !options.isRetryable(error)) throw error;
      const wait = options.retryAfterMs?.(error);
      await sleep(
        retryDelayMs({
          attempt,
          baseMs,
          capMs,
          ...(options.jitterRatio !== undefined ? { jitterRatio: options.jitterRatio } : {}),
          ...(options.random ? { random: options.random } : {}),
          ...(wait !== undefined ? { retryAfterMs: wait } : {}),
        }),
      );
    }
  }
  throw lastError;
}
