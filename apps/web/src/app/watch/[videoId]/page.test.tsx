import type { Video } from '@w3ds/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCreatorVideoService: vi.fn(),
  withPublicThumbnailUrl: vi.fn(),
}));

vi.mock('../../../server/creator-video', () => ({
  getCreatorVideoService: mocks.getCreatorVideoService,
}));

vi.mock('../../../server/public-video-playback', () => ({
  withPublicThumbnailUrl: mocks.withPublicThumbnailUrl,
}));

import { generateWatchPageMetadata } from './watch-page-metadata';

const video: Video = {
  id: 'video-1',
  publicVideoId: 'pub_video-1',
  channelId: 'channel-1',
  title: 'A real frame from the video',
  description: 'A share preview should show the video itself.',
  thumbnailUrl: '/api/videos/public/pub_video-1/thumbnail',
  durationSeconds: 90,
  status: 'published',
  visibility: 'public',
  createdAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: [],
};

describe('watch page metadata', () => {
  beforeEach(() => {
    mocks.getCreatorVideoService.mockReset();
    mocks.withPublicThumbnailUrl.mockReset();
  });

  it('uses the public video thumbnail as the Open Graph and Twitter preview', async () => {
    mocks.getCreatorVideoService.mockReturnValue({
      getPublicVideo: vi.fn().mockResolvedValue(video),
    });
    mocks.withPublicThumbnailUrl.mockResolvedValue(video);

    const metadata = await generateWatchPageMetadata(video.publicVideoId ?? '');

    expect(metadata).toMatchObject({
      title: video.title,
      description: video.description,
      alternates: { canonical: '/watch/pub_video-1' },
      openGraph: {
        type: 'video.other',
        url: '/watch/pub_video-1',
        images: [
          {
            url: 'https://vidak.postplatforms.com/api/videos/public/pub_video-1/thumbnail',
            alt: 'A real frame from the video video preview',
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        images: ['https://vidak.postplatforms.com/api/videos/public/pub_video-1/thumbnail'],
      },
    });
    expect(mocks.withPublicThumbnailUrl).toHaveBeenCalledWith(video);
  });

  it('keeps the site-wide fallback when no public thumbnail is available', async () => {
    mocks.getCreatorVideoService.mockReturnValue({
      getPublicVideo: vi.fn().mockRejectedValue(new Error('Video was not found.')),
    });

    await expect(generateWatchPageMetadata('missing-video')).resolves.toEqual({});
  });
});
