import { describe, expect, it, vi } from 'vitest';
import { fetchPreviewWithTimeout } from './preview-fetch';

describe('fetchPreviewWithTimeout', () => {
  it('releases a stalled preview request when its card is cancelled', async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn(
      (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Cancelled', 'AbortError')),
          );
        }),
    );

    const request = fetchPreviewWithTimeout('/api/preview', {
      fetcher,
      signal: caller.signal,
      timeoutMs: 60_000,
    });
    caller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('releases a stalled preview request after the timeout', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetcher = vi.fn(
        (_input: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init.signal ?? undefined;
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Timed out', 'AbortError')),
            );
          }),
      );

      const request = fetchPreviewWithTimeout('/api/preview', { fetcher, timeoutMs: 500 });
      const expectation = expect(request).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(500);

      await expectation;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes successful preview responses through unchanged', async () => {
    const response = new Response('poster', {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
    const fetcher = vi.fn(async (_input: string, _init: RequestInit) => response);

    await expect(fetchPreviewWithTimeout('/api/preview', { fetcher })).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/preview',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
});
