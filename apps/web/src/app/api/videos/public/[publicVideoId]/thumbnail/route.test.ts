import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getCreatorVideoService: vi.fn(),
  getMediaAssetService: vi.fn(),
  getVideoPreviewService: vi.fn(),
}));

vi.mock('../../../../../../server/creator-video', () => ({
  CreatorVideoError: class CreatorVideoError extends Error {},
  getCreatorVideoService: mocks.getCreatorVideoService,
}));

vi.mock('../../../../../../server/media-asset', () => ({
  MediaAssetError: class MediaAssetError extends Error {},
  getMediaAssetService: mocks.getMediaAssetService,
}));

vi.mock('../../../../../../server/video-preview', () => ({
  VideoPreviewError: class VideoPreviewError extends Error {},
  getVideoPreviewService: mocks.getVideoPreviewService,
}));

import { GET } from './route';

const context = { params: Promise.resolve({ publicVideoId: 'pub_video' }) };

describe('public video thumbnail route', () => {
  beforeEach(() => {
    mocks.getCreatorVideoService.mockReset();
    mocks.getMediaAssetService.mockReset();
    mocks.getVideoPreviewService.mockReset();
    mocks.getCreatorVideoService.mockReturnValue({
      getPublicVideo: vi.fn().mockResolvedValue({ id: 'video-1' }),
    });
  });

  it('prefers a generated video frame over a legacy uploaded image', async () => {
    const openPublishedThumbnailDownload = vi.fn();
    mocks.getMediaAssetService.mockReturnValue({ openPublishedThumbnailDownload });
    mocks.getVideoPreviewService.mockReturnValue({
      openPublishedPreview: vi.fn().mockResolvedValue({
        status: 'ready',
        body: new Uint8Array([0xff, 0xd8, 0xff]),
        contentType: 'image/jpeg',
      }),
    });

    const response = await GET(new NextRequest('https://vidak.example/thumbnail'), context);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(await response.arrayBuffer()).toEqual(new Uint8Array([0xff, 0xd8, 0xff]).buffer);
    expect(openPublishedThumbnailDownload).not.toHaveBeenCalled();
  });

  it('keeps an uploaded thumbnail as a fallback while frame extraction is pending', async () => {
    mocks.getVideoPreviewService.mockReturnValue({
      openPublishedPreview: vi.fn().mockResolvedValue({ status: 'processing' }),
    });
    mocks.getMediaAssetService.mockReturnValue({
      openPublishedThumbnailDownload: vi.fn().mockResolvedValue({
        status: 200,
        body: new Uint8Array([1, 2, 3]),
        headers: { 'Content-Type': 'image/png' },
      }),
    });

    const response = await GET(new NextRequest('https://vidak.example/thumbnail'), context);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });
});
