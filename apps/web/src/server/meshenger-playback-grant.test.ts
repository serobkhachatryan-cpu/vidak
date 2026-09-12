import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  meshengerPlaybackGrantPath,
  probeMeshengerPlaybackGrant,
  readMeshengerPlaybackGrantConfig,
  requestMeshengerPlaybackGrant,
  signMeshengerPlaybackGrantRequest,
} from './meshenger-playback-grant';

const now = 1_789_000_000_000;
const secret = '0123456789abcdef0123456789abcdef';
const config = {
  endpoint: `https://meshenger.example${meshengerPlaybackGrantPath}`,
  secret,
};
const request = {
  viewerEName: '@11111111-1111-4111-8111-111111111111',
  viewerChatGrantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  callSessionVault: '@22222222-2222-4222-8222-222222222222',
  callSessionEnvelopeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sourceChatId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  fileUri:
    'w3ds://file?id=@22222222-2222-4222-8222-222222222222/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

function grantedResponse(mediaUrl = 'https://media.example/recording.mp4?source-token=private') {
  return new Response(
    JSON.stringify({
      version: 1,
      status: 'granted',
      expiresAt: new Date(now + 60_000).toISOString(),
      mediaUrl,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('Meshenger playback grant bridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('only enables a safe exact endpoint with a dedicated server secret', () => {
    expect(readMeshengerPlaybackGrantConfig({})).toBeUndefined();
    expect(
      readMeshengerPlaybackGrantConfig({
        MESHENGER_PLAYBACK_GRANT_URL: `https://meshenger.example${meshengerPlaybackGrantPath}`,
        VIDAK_PLAYBACK_BRIDGE_SECRET: secret,
      }),
    ).toEqual(config);
    expect(
      readMeshengerPlaybackGrantConfig({
        MESHENGER_PLAYBACK_GRANT_URL: 'https://meshenger.example/not-the-bridge',
        VIDAK_PLAYBACK_BRIDGE_SECRET: secret,
      }),
    ).toBeUndefined();
    expect(
      readMeshengerPlaybackGrantConfig({
        MESHENGER_PLAYBACK_GRANT_URL: `https://127.0.0.1${meshengerPlaybackGrantPath}`,
        VIDAK_PLAYBACK_BRIDGE_SECRET: secret,
      }),
    ).toBeUndefined();
  });

  it('signs the exact canonical CallSession request and never exposes a source URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(grantedResponse());

    await expect(
      requestMeshengerPlaybackGrant({ config, request, now: () => now, fetchImpl: fetcher }),
    ).resolves.toEqual({
      kind: 'granted',
      mediaUrl: 'https://media.example/recording.mp4?source-token=private',
      expiresAt: now + 60_000,
    });

    const [endpoint, init] = fetcher.mock.calls[0] ?? [];
    expect(endpoint).toBe(config.endpoint);
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    const headers = new Headers((init as RequestInit).headers);
    const rawBody = String((init as RequestInit).body);
    expect(JSON.parse(rawBody)).toEqual({ version: 1, ...request });
    expect(headers.get('x-vidak-playback-timestamp')).toBe(String(now));
    expect(headers.get('x-vidak-playback-nonce')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(headers.get('x-vidak-playback-signature')).toBe(
      signMeshengerPlaybackGrantRequest({
        secret,
        timestamp: String(now),
        nonce: headers.get('x-vidak-playback-nonce') ?? '',
        rawBody,
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls[0])).not.toContain('source-token=private');
  });

  it('proves a configured source bridge exists without sending a viewer or recording', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response('{"error":"bad_request"}', {
        status: 400,
        headers: { 'cache-control': 'no-store' },
      }),
    );

    await expect(
      probeMeshengerPlaybackGrant({ config, now: () => now, fetchImpl: fetcher }),
    ).resolves.toBeUndefined();

    const [endpoint, init] = fetcher.mock.calls[0] ?? [];
    expect(endpoint).toBe(config.endpoint);
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('x-vidak-playback-signature')).toBe(
      signMeshengerPlaybackGrantRequest({
        secret,
        timestamp: String(now),
        nonce: headers.get('x-vidak-playback-nonce') ?? '',
        rawBody: '{}',
      }),
    );
    expect(JSON.stringify(init)).not.toContain('@11111111');
    expect(JSON.stringify(init)).not.toContain('cccccccc');
  });

  it('rejects a missing, unauthenticated, or cacheable source bridge probe', async () => {
    for (const response of [
      new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }),
      new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } }),
      new Response(null, { status: 400 }),
    ]) {
      const fetcher: typeof fetch = async () => response;
      await expect(
        probeMeshengerPlaybackGrant({ config, now: () => now, fetchImpl: fetcher }),
      ).rejects.toThrow('Meshenger playback bridge health probe failed.');
    }
  });

  it('returns only typed failures for source responses and never uses their body', async () => {
    const privateError = 'https://source.example/problem?token=must-not-leak';
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(privateError, { status: 409 }))
      .mockResolvedValueOnce(new Response(privateError, { status: 404 }))
      .mockResolvedValueOnce(new Response(privateError, { status: 503 }));

    const results = await Promise.all(
      [0, 1, 2].map(() =>
        requestMeshengerPlaybackGrant({ config, request, now: () => now, fetchImpl: fetcher }),
      ),
    );
    expect(results).toEqual([
      { kind: 'not_eligible' },
      { kind: 'not_found' },
      { kind: 'unavailable' },
    ]);
    expect(JSON.stringify(results)).not.toContain('source.example');
    expect(JSON.stringify(results)).not.toContain('must-not-leak');
  });

  it('rejects unsafe or malformed granted responses without returning their URL', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(grantedResponse('https://127.0.0.1/recording.mp4?token=private'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ version: 1, status: 'granted', mediaUrl: 'https://media.example/x' }),
          {
            status: 200,
          },
        ),
      );

    const first = await requestMeshengerPlaybackGrant({
      config,
      request,
      now: () => now,
      fetchImpl: fetcher,
    });
    const second = await requestMeshengerPlaybackGrant({
      config,
      request,
      now: () => now,
      fetchImpl: fetcher,
    });
    expect(first).toEqual({ kind: 'rejected' });
    expect(second).toEqual({ kind: 'rejected' });
    expect(JSON.stringify([first, second])).not.toContain('private');
  });

  it('does not start a request after caller cancellation or without bridge configuration', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();

    await expect(
      requestMeshengerPlaybackGrant({
        config,
        request,
        now: () => now,
        signal: controller.signal,
        fetchImpl: fetcher,
      }),
    ).resolves.toEqual({ kind: 'cancelled' });
    await expect(
      requestMeshengerPlaybackGrant({
        config: undefined,
        request,
        now: () => now,
        fetchImpl: fetcher,
      }),
    ).resolves.toEqual({ kind: 'not_configured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
