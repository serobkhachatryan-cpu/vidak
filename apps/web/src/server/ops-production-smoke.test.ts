import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const smokeModule = (await import(
  pathToFileURL(resolve(repoRoot, 'scripts/verify-production.mjs')).href
)) as {
  ProductionSmokeError: new (message: string) => Error;
  runProductionSmoke: (input: { origin: string; fetchImpl: typeof fetch }) => Promise<{
    publicChannels: number;
    publicVideos: number;
    checkedPublicPosters: number;
    checkedPublicPlayback: number;
    searchChecked: boolean;
  }>;
};

const origin = 'https://vidak.example';

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function createFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof request === 'string' ? request : request.toString());
    const path = `${url.pathname}${url.search}`;
    if (path === '/') {
      return new Response('<!doctype html>', {
        headers: {
          'content-security-policy': "default-src 'self'",
          'referrer-policy': 'strict-origin-when-cross-origin',
          'strict-transport-security': 'max-age=31536000',
          'x-frame-options': 'DENY',
        },
      });
    }
    if (path === '/api/health/live') return json({ status: 'ok' });
    if (path === '/api/health/ready') return json({ status: 'ready' });
    if (url.pathname === '/api/channels/public') {
      return json({ items: [overrides.channel ?? { id: 'public-channel', name: 'Channel' }] });
    }
    if (url.pathname === '/api/videos/public') {
      const item = overrides.video ?? {
        id: 'pub-video',
        publicVideoId: 'pub-video',
        title: 'Release recap',
        durationSeconds: 42,
        thumbnailUrl: '/api/videos/public/pub-video/thumbnail',
        mediaContentUrl: '/api/videos/public/pub-video/media',
      };
      return json({ items: [item] });
    }
    if (url.pathname.endsWith('/thumbnail')) {
      return new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } });
    }
    if (url.pathname.endsWith('/media')) {
      expect(init?.headers).toMatchObject({ Range: 'bytes=0-1' });
      return new Response('mp4', {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/42' },
      });
    }
    if (
      ['/api/evault/videos', '/api/videos/mine', '/api/auth/me', '/api/support/reports'].includes(
        url.pathname,
      )
    ) {
      return json({ error: { code: 'invalid_session' } }, 401);
    }
    throw new Error(`Unexpected smoke request: ${path}`);
  }) as unknown as typeof fetch;
}

describe('production smoke verifier', () => {
  it('checks only aggregate public integrity and anonymous authorization boundaries', async () => {
    const summary = await smokeModule.runProductionSmoke({ origin, fetchImpl: createFetch() });

    expect(summary).toEqual({
      publicChannels: 1,
      publicVideos: 1,
      checkedPublicPosters: 1,
      checkedPublicPlayback: 1,
      searchChecked: true,
    });
  });

  it('rejects a public identity-field regression without echoing its value', async () => {
    await expect(
      smokeModule.runProductionSmoke({
        origin,
        fetchImpl: createFetch({ channel: { id: 'public-channel', ownerId: 'must-not-leak' } }),
      }),
    ).rejects.toThrow(smokeModule.ProductionSmokeError);
    await expect(
      smokeModule.runProductionSmoke({
        origin,
        fetchImpl: createFetch({ channel: { id: 'public-channel', ownerId: 'must-not-leak' } }),
      }),
    ).rejects.not.toThrow('must-not-leak');
  });
});
