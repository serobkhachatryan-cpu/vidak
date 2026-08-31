/**
 * Exponential backoff for background 429 retries. Never used to stretch the
 * interactive HTTP request — fail-fast there, retry here.
 */
export function nextBackoffMs(attempt: number, baseMs = 250, capMs = 4_000): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(capMs, baseMs * 2 ** exp);
}

export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: {
    isRetryable: (error: unknown) => boolean;
    maxAttempts?: number;
    baseMs?: number;
    capMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseMs = options.baseMs ?? 250;
  const capMs = options.capMs ?? 4_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !options.isRetryable(error)) throw error;
      await sleep(nextBackoffMs(attempt, baseMs, capMs));
    }
  }
  throw lastError;
}
