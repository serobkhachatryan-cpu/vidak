import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  createLibrary: vi.fn(),
  getAuthService: vi.fn(),
}));

vi.mock('../../../../../server/evault-video-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/evault-video-library')>()),
  createEVaultVideoLibrary: mocks.createLibrary,
}));

vi.mock('../../../../../server/w3ds-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../server/w3ds-auth')>()),
  getW3dsAuthService: mocks.getAuthService,
}));

import { EVaultVideoLibraryError } from '../../../../../server/evault-video-library';
import { setOperationalLogSinkForTests } from '../../../../../server/ops-observability';
import { GET } from './route';

const viewer = { eName: '@viewer.w3id' };
let operationalLogs: string[] = [];

describe('eVault video stream route', () => {
  beforeEach(() => {
    operationalLogs = [];
    setOperationalLogSinkForTests((line) => operationalLogs.push(line));
    mocks.createLibrary.mockReset();
    mocks.getAuthService.mockReset();
    mocks.getAuthService.mockReturnValue({
      getSession: vi.fn().mockResolvedValue({ user: viewer }),
    });
  });

  afterEach(() => {
    setOperationalLogSinkForTests(undefined);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes an expired upstream media URL once and preserves the byte range', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockResolvedValueOnce('https://media.example/expired.mp4')
      .mockResolvedValueOnce('https://media.example/refreshed.mp4');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, invalidateMediaUrl });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        new Response('recovered', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-8/9', 'Content-Type': 'video/mp4' },
        }),
      );
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/stream-1', {
        headers: { authorization: 'Bearer access-token', range: 'bytes=0-8' },
      }),
      { params: Promise.resolve({ streamId: 'stream-1' }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-8/9');
    await expect(response.text()).resolves.toBe('recovered');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'stream-1');
    expect(resolveMediaUrl).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://media.example/refreshed.mp4',
      expect.objectContaining({ headers: { Range: 'bytes=0-8' } }),
    );
  });

  it('renews an expired playable stream before opening the upstream video', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new EVaultVideoLibraryError('This video link has expired.', 'stream_expired', 401),
      )
      .mockResolvedValueOnce('https://media.example/renewed.mp4');
    const renewPlayableStream = vi.fn().mockResolvedValue('renewed-stream');
    mocks.createLibrary.mockReturnValue({ resolveMediaUrl, renewPlayableStream });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('renewed', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-6/7', 'Content-Type': 'video/mp4' },
        }),
      ),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/expired-stream', {
        headers: { authorization: 'Bearer access-token', range: 'bytes=0-6' },
      }),
      { params: Promise.resolve({ streamId: 'expired-stream' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('renewed');
    expect(renewPlayableStream).toHaveBeenCalledWith(viewer, 'expired-stream');
    expect(resolveMediaUrl).toHaveBeenNthCalledWith(2, viewer, 'renewed-stream');
  });

  it('refreshes the renewed stream when its first upstream source is rejected', async () => {
    const resolveMediaUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new EVaultVideoLibraryError('This video link has expired.', 'stream_expired', 401),
      )
      .mockResolvedValueOnce('https://media.example/renewed.mp4')
      .mockResolvedValueOnce('https://media.example/recovered.mp4');
    const renewPlayableStream = vi.fn().mockResolvedValue('renewed-stream');
    const invalidateMediaUrl = vi.fn();
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl,
      renewPlayableStream,
      invalidateMediaUrl,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response('recovered', { status: 206 })),
    );

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/expired-stream', {
        headers: { authorization: 'Bearer access-token', 'x-request-id': 'playback-recovery-1' },
      }),
      { params: Promise.resolve({ streamId: 'expired-stream' }) },
    );

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe('recovered');
    expect(renewPlayableStream).toHaveBeenCalledWith(viewer, 'expired-stream');
    expect(invalidateMediaUrl).toHaveBeenCalledWith(viewer, 'renewed-stream');
    expect(resolveMediaUrl).toHaveBeenLastCalledWith(viewer, 'renewed-stream');
    expect(operationalLogs).toContain(
      JSON.stringify({
        level: 'info',
        category: 'video_playback',
        correlationId: 'playback-recovery-1',
        code: 'stream_renewed_source_recovered',
      }),
    );
  });

  it('reports an opaque playback failure without source details', async () => {
    mocks.createLibrary.mockReturnValue({
      resolveMediaUrl: vi
        .fn()
        .mockRejectedValue(new Error('https://signed.example/private-source?token=secret')),
    });

    const response = await GET(
      new NextRequest('https://vidak.example/api/evault/videos/private-stream', {
        headers: { authorization: 'Bearer access-token', 'x-request-id': 'playback-failure-1' },
      }),
      { params: Promise.resolve({ streamId: 'private-stream' }) },
    );

    expect(response.status).toBe(500);
    expect(operationalLogs).toHaveLength(1);
    expect(operationalLogs[0]).toContain('"category":"video_playback"');
    expect(operationalLogs[0]).toContain('"code":"internal_error"');
    expect(operationalLogs[0]).not.toContain('private-stream');
    expect(operationalLogs[0]).not.toContain('signed.example');
    expect(operationalLogs[0]).not.toContain('secret');
  });
});
