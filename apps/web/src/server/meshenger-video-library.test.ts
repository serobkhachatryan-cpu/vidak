import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  createMeshengerVideoLibrary,
  createMeshengerVideoStreamId,
  verifyMeshengerVideoStreamId,
} from './meshenger-video-library';

const secret = '12345678901234567890123456789012';
const grant = {
  eName: '@person.w3id',
  fileUri: 'w3ds://file?id=@vault.w3id/file_123',
  expiresAt: Date.now() + 60_000,
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function configuredLibrary() {
  return createMeshengerVideoLibrary({
    W3DS_AUTH_PLATFORM_NAME: 'vidak',
    W3DS_REGISTRY_BASE_URL: 'https://registry.example',
    W3DS_AUTH_JWT_SECRET: secret,
  });
}

describe('Meshenger video library', () => {
  it('creates an opaque signed stream id and restores only its validated reference', () => {
    const streamId = createMeshengerVideoStreamId(grant, secret);
    expect(streamId).not.toContain('http');
    expect(verifyMeshengerVideoStreamId(streamId, secret)).toEqual(grant);
  });

  it('rejects forged and expired stream ids', () => {
    const streamId = createMeshengerVideoStreamId(grant, secret);
    expect(() => verifyMeshengerVideoStreamId(`${streamId}x`, secret)).toThrow(
      expect.objectContaining({ code: 'invalid_stream' }),
    );
    expect(() =>
      verifyMeshengerVideoStreamId(
        createMeshengerVideoStreamId({ ...grant, expiresAt: Date.now() - 1 }, secret),
        secret,
      ),
    ).toThrow(expect.objectContaining({ code: 'stream_expired' }));
  });

  it('fails closed when the server-side W3DS registry configuration is missing', () => {
    expect(() =>
      createMeshengerVideoLibrary({
        W3DS_AUTH_JWT_SECRET: secret,
      }),
    ).toThrow(expect.objectContaining({ code: 'not_configured' }));
  });

  it('discovers video messages and loose video files without exposing their media URLs', async () => {
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/platforms/certification') return json({ token: 'registry-platform-token' });
      const body = JSON.parse(String(init.body)) as { variables: { ontologyId: string } };
      if (body.variables.ontologyId === '550e8400-e29b-41d4-a716-446655440004') {
        return json({ data: { metaEnvelopes: { edges: [{ node: {
          id: 'message-1', ontology: body.variables.ontologyId, parsed: {
            type: 'video', fileId: 'w3ds://file?id=@person.w3id/message-video',
            file: { filename: 'Circle update.mp4' }, durationSec: 12, shape: 'circle', createdAt: '2026-08-20T10:00:00.000Z',
          },
        } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (body.variables.ontologyId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890') {
        return json({ data: { metaEnvelopes: { edges: [{ node: {
          id: 'loose-video', ontology: body.variables.ontologyId, parsed: {
            contentType: 'video/mp4', filename: 'A shared clip.mp4', createdAt: '2026-08-19T10:00:00.000Z',
          },
        } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      return json({ data: { metaEnvelopes: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const videos = await configuredLibrary().list({ eName: '@person.w3id', eVaultUri: 'https://vault.example' });
      expect(videos).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'video-message', title: 'Circle update.mp4', shape: 'circle', durationSeconds: 12 }),
        expect.objectContaining({ kind: 'file', title: 'A shared clip.mp4' }),
      ]));
      expect(JSON.stringify(videos)).not.toContain('https://');
      expect(fetcher.mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body).includes('$ontologyId: ID!'))).toBe(true);
      expect(fetcher).toHaveBeenCalledWith(
        expect.objectContaining({ pathname: '/platforms/certification' }),
        expect.objectContaining({ body: JSON.stringify({ platform: 'vidak' }) }),
      );
      expect(fetcher.mock.calls.filter(([url]) => (url as URL).pathname === '/platforms/certification')).toHaveLength(1);
      const authenticatedRequests = fetcher.mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        return new Headers(init?.headers).get('Authorization') === 'Bearer registry-platform-token';
      });
      expect(authenticatedRequests).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a private IPv6 media destination before the player can proxy it', async () => {
    const streamId = createMeshengerVideoStreamId({ ...grant, fileUri: 'w3ds://file?id=@vault.w3id/file_123' }, secret);
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') return json({ ename: '@vault.w3id', uri: 'https://vault.example' });
      if (url.pathname === '/platforms/certification') return json({ token: 'registry-platform-token' });
      return json({ data: { metaEnvelope: {
        id: 'file_123', ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', parsed: { publicUrl: 'https://[::1]/video.mp4' },
      } } });
    }));

    try {
      await expect(configuredLibrary().resolveMediaUrl({ eName: '@person.w3id' }, streamId)).rejects.toThrow(
        expect.objectContaining({ code: 'unsafe_media_url' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reuses a resolved media URL for repeated byte-range requests from the same signed grant', async () => {
    const cachedGrant = {
      eName: '@cache-test.w3id',
      fileUri: 'w3ds://file?id=@vault.w3id/cache-file',
      expiresAt: Date.now() + 60_000,
    };
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname === '/resolve') return json({ ename: '@vault.w3id', uri: 'https://vault.example' });
      if (url.pathname === '/platforms/certification') return json({ token: 'registry-platform-token' });
      return json({ data: { metaEnvelope: {
        id: 'cache-file', ontology: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', parsed: { publicUrl: 'https://media.example/video.mp4' },
      } } });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const library = configuredLibrary();
      const streamId = createMeshengerVideoStreamId(cachedGrant, secret);
      await expect(library.resolveMediaUrl({ eName: cachedGrant.eName }, streamId)).resolves.toBe('https://media.example/video.mp4');
      await expect(library.resolveMediaUrl({ eName: cachedGrant.eName }, streamId)).resolves.toBe('https://media.example/video.mp4');
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
