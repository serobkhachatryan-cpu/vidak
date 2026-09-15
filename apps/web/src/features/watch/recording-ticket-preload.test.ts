import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createContinuousRecordingTicket,
  preloadContinuousRecordingTicket,
  resetRecordingTicketPreloadsForTests,
  takePreloadedContinuousRecordingTicket,
} from './recording-ticket-preload';

afterEach(() => {
  resetRecordingTicketPreloadsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('continuous recording ticket preload', () => {
  it('starts one ticket at the card boundary and lets Watch adopt that exact promise', async () => {
    let finish: (() => void) | undefined;
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          finish = () =>
            resolve(
              new Response(JSON.stringify({ playbackUrl: '/api/evault/recordings/opaque' }), {
                status: 200,
              }),
            );
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const streamIds = ['first-opaque-stream', 'second-opaque-stream'];

    preloadContinuousRecordingTicket(streamIds);
    const first = takePreloadedContinuousRecordingTicket(streamIds);
    const replay = takePreloadedContinuousRecordingTicket(streamIds);

    expect(first).toBeDefined();
    expect(replay?.promise).toBe(first?.promise);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/evault/videos/first-opaque-stream/recording-ticket',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ streamIds }),
      }),
    );
    const initialRequest = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(initialRequest?.keepalive).toBeUndefined();

    finish?.();
    await expect(first?.promise).resolves.toEqual({
      playbackUrl: '/api/evault/recordings/opaque',
    });

    first?.release();
    expect(takePreloadedContinuousRecordingTicket(streamIds)).toBeUndefined();
  });

  it('does not reuse a preloaded ticket after the player has adopted it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ playbackUrl: '/api/evault/recordings/first' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ playbackUrl: '/api/evault/recordings/retry' }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    const streamIds = ['first-opaque-stream', 'second-opaque-stream'];

    preloadContinuousRecordingTicket(streamIds);
    const handoff = takePreloadedContinuousRecordingTicket(streamIds);
    await handoff?.promise;
    handoff?.release();

    await expect(createContinuousRecordingTicket(streamIds)).resolves.toEqual({
      playbackUrl: '/api/evault/recordings/retry',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps server errors as structured playback failures instead of exposing a response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'authorization_denied' } }), {
          status: 403,
        }),
      ),
    );

    await expect(createContinuousRecordingTicket(['opaque-stream'])).resolves.toEqual({
      errorCode: 'authorization_denied',
    });
  });

  it('expires an abandoned client-side handoff before a later navigation can use it', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ playbackUrl: '/api/evault/recordings/opaque' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const streamIds = ['opaque-stream'];

    preloadContinuousRecordingTicket(streamIds);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(takePreloadedContinuousRecordingTicket(streamIds)).toBeUndefined();
  });

  it('releases an unopened opaque ticket when an abandoned preload expires', async () => {
    vi.useFakeTimers();
    const playbackUrl = `/api/evault/recordings/${'a'.repeat(43)}`;
    let resolveTicket: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((url: string) => {
      if (url === '/api/evault/videos/opaque-stream/recording-ticket') {
        return new Promise<Response>((resolve) => {
          resolveTicket = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetcher);

    preloadContinuousRecordingTicket(['opaque-stream', 'second-opaque-stream']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveTicket?.(new Response(JSON.stringify({ playbackUrl }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      playbackUrl,
      expect.objectContaining({
        method: 'DELETE',
        cache: 'no-store',
        credentials: 'same-origin',
        keepalive: true,
      }),
    );
  });

  it('never cancels a preloaded ticket after the Watch page has adopted it', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ playbackUrl: `/api/evault/recordings/${'b'.repeat(43)}` }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const streamIds = ['opaque-stream', 'second-opaque-stream'];

    preloadContinuousRecordingTicket(streamIds);
    const handoff = takePreloadedContinuousRecordingTicket(streamIds);
    await handoff?.promise;
    handoff?.release();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
