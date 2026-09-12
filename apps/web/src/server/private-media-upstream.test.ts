import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  isRefreshablePrivateMediaFailure,
  openPrivateMediaUpstream,
  parseSafePrivateMediaUpstreamUrl,
} from './private-media-upstream';

describe('private media upstream transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('follows exactly one validated redirect server-side and forwards only Range', async () => {
    const redirect = new Response('discard this redirect body', {
      status: 302,
      headers: { Location: '/delivery.mp4?cdn-token=kept-server-side' },
    });
    const cancel = vi.spyOn(responseBody(redirect), 'cancel');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(
        new Response('media bytes', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-10/100' },
        }),
      );
    vi.stubGlobal('fetch', fetcher);

    const result = await openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4?source-token=private',
      range: 'bytes=0-10',
      headerTimeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      kind: 'success',
      upstreamAttempts: 2,
      redirectCount: 1,
    });
    if (result.kind === 'success') {
      await expect(result.response.text()).resolves.toBe('media bytes');
    }
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://media.example/original.mp4?source-token=private',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://media.example/delivery.mp4?cdn-token=kept-server-side',
      expect.objectContaining({
        headers: { Range: 'bytes=0-10' },
        redirect: 'manual',
      }),
    );
    const firstInit = (fetcher.mock.calls[0] ?? [])[1] as RequestInit | undefined;
    const secondInit = (fetcher.mock.calls[1] ?? [])[1] as RequestInit | undefined;
    const firstHeaders = new Headers(firstInit?.headers);
    const secondHeaders = new Headers(secondInit?.headers);
    expect([...firstHeaders.entries()]).toEqual([['range', 'bytes=0-10']]);
    expect([...secondHeaders.entries()]).toEqual([['range', 'bytes=0-10']]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('never follows an unsafe redirect or place its target in its typed failure', async () => {
    const privateLocation = 'https://127.0.0.1/admin?token=must-not-leak';
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 307, headers: { Location: privateLocation } }),
      );
    vi.stubGlobal('fetch', fetcher);

    const result = await openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4?source-token=private',
    });

    expect(result).toMatchObject({
      kind: 'failure',
      failure: { kind: 'unsafe_redirect' },
      upstreamAttempts: 1,
      redirectCount: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(privateLocation);
    expect(JSON.stringify(result)).not.toContain('source-token');
  });

  it('cancels a second redirect response and enforces the one-hop limit', async () => {
    const first = new Response('first redirect', {
      status: 302,
      headers: { Location: 'https://cdn.example/first-hop.mp4' },
    });
    const second = new Response('second redirect', {
      status: 308,
      headers: { Location: 'https://edge.example/second-hop.mp4' },
    });
    const firstCancel = vi.spyOn(responseBody(first), 'cancel');
    const secondCancel = vi.spyOn(responseBody(second), 'cancel');
    const fetcher = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    vi.stubGlobal('fetch', fetcher);

    const result = await openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4',
    });

    expect(result).toMatchObject({
      kind: 'failure',
      failure: { kind: 'redirect_limit' },
      upstreamAttempts: 2,
      redirectCount: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(secondCancel).toHaveBeenCalledTimes(1);
  });

  it('uses one header deadline across the initial request and its redirect', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let secondRequestStarted: (() => void) | undefined;
    const secondRequest = new Promise<void>((resolve) => {
      secondRequestStarted = resolve;
    });
    const fetcher = vi.fn((_: string, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected a header deadline signal.');
      signals.push(signal);
      if (signals.length === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: 'https://cdn.example/delivery.mp4' },
          }),
        );
      }
      secondRequestStarted?.();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('upstream aborted')), {
          once: true,
        });
      });
    });
    vi.stubGlobal('fetch', fetcher);

    const pending = openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4',
      headerTimeoutMs: 25,
    });
    await secondRequest;
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);

    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result).toMatchObject({
      kind: 'failure',
      failure: { kind: 'pre_header_timeout' },
      upstreamAttempts: 2,
      redirectCount: 1,
    });
  });

  it('does not commit a successful proxy response until the upstream has emitted media bytes', async () => {
    vi.useFakeTimers();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      status: 206,
      headers: { 'content-range': 'bytes 0-9/10', 'content-type': 'video/mp4' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const pending = openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4',
      headerTimeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(bodyController).toBeDefined();
    expect(result).toMatchObject({
      kind: 'failure',
      failure: { kind: 'pre_header_timeout' },
      upstreamAttempts: 1,
    });
    expect(cancelled).toBe(true);
  });

  it('preserves the first byte gated from the upstream body', async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 206,
          headers: { 'content-range': 'bytes 0-3/4', 'content-type': 'video/mp4' },
        }),
      ),
    );

    const pending = openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4',
      headerTimeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(bodyController).toBeDefined());
    bodyController?.enqueue(new Uint8Array([1, 2]));
    bodyController?.enqueue(new Uint8Array([3, 4]));
    bodyController?.close();

    const result = await pending;
    expect(result).toMatchObject({ kind: 'success', upstreamAttempts: 1 });
    if (result.kind === 'success') {
      await expect(result.response.arrayBuffer()).resolves.toEqual(
        new Uint8Array([1, 2, 3, 4]).buffer,
      );
      expect(result.response.headers.get('content-range')).toBe('bytes 0-3/4');
    }
  });

  it('returns non-sensitive pre-header network and caller-cancellation outcomes', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('https://bad.example/?token=secret'));
    vi.stubGlobal('fetch', fetcher);

    const networkFailure = await openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4',
    });
    expect(networkFailure).toMatchObject({
      kind: 'failure',
      failure: { kind: 'pre_header_network' },
      upstreamAttempts: 1,
    });
    expect(JSON.stringify(networkFailure)).not.toContain('bad.example');
    expect(JSON.stringify(networkFailure)).not.toContain('secret');

    const caller = new AbortController();
    caller.abort();
    const callerCancellation = await openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4',
      signal: caller.signal,
    });
    expect(callerCancellation).toMatchObject({
      kind: 'failure',
      failure: { kind: 'caller_cancelled' },
      upstreamAttempts: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns a typed stale-source status after cancelling its response body', async () => {
    const gone = new Response('private upstream error body', { status: 410 });
    const cancel = vi.spyOn(responseBody(gone), 'cancel');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(gone));

    const result = await openPrivateMediaUpstream({
      mediaUrl: 'https://media.example/original.mp4',
    });

    expect(result).toMatchObject({
      kind: 'failure',
      failure: { kind: 'upstream_status', upstreamStatus: 410 },
      upstreamAttempts: 1,
    });
    if (result.kind === 'failure') {
      expect(isRefreshablePrivateMediaFailure(result.failure)).toBe(true);
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private upstream error body');
  });

  it('marks only stale statuses and pre-header failures as one-refresh candidates', async () => {
    expect(isRefreshablePrivateMediaFailure({ kind: 'upstream_status', upstreamStatus: 401 })).toBe(
      true,
    );
    expect(isRefreshablePrivateMediaFailure({ kind: 'upstream_status', upstreamStatus: 403 })).toBe(
      true,
    );
    expect(isRefreshablePrivateMediaFailure({ kind: 'upstream_status', upstreamStatus: 404 })).toBe(
      true,
    );
    expect(isRefreshablePrivateMediaFailure({ kind: 'upstream_status', upstreamStatus: 410 })).toBe(
      true,
    );
    expect(isRefreshablePrivateMediaFailure({ kind: 'upstream_status', upstreamStatus: 503 })).toBe(
      false,
    );
    expect(isRefreshablePrivateMediaFailure({ kind: 'pre_header_network' })).toBe(true);
    expect(isRefreshablePrivateMediaFailure({ kind: 'pre_header_timeout' })).toBe(true);
    expect(isRefreshablePrivateMediaFailure({ kind: 'unsafe_redirect' })).toBe(false);
  });

  it('accepts only a safe HTTPS URL before any upstream request', () => {
    expect(
      parseSafePrivateMediaUpstreamUrl(
        '/delivery.mp4',
        new URL('https://media.example/original'),
      )?.toString(),
    ).toBe('https://media.example/delivery.mp4');
    expect(parseSafePrivateMediaUpstreamUrl('http://media.example/video.mp4')).toBeUndefined();
    expect(
      parseSafePrivateMediaUpstreamUrl('https://user:pass@media.example/video.mp4'),
    ).toBeUndefined();
    expect(parseSafePrivateMediaUpstreamUrl('https://localhost/video.mp4')).toBeUndefined();
    expect(parseSafePrivateMediaUpstreamUrl('https://[::1]/video.mp4')).toBeUndefined();
  });
});

function responseBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error('Expected a response body.');
  return response.body;
}
