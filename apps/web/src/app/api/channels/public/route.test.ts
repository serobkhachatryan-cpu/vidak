import type { Channel } from '@w3ds/types';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCreatorVideoService: vi.fn() }));

vi.mock('../../../../server/creator-video', () => ({
  getCreatorVideoService: mocks.getCreatorVideoService,
}));

import { GET } from './route';

const channel: Channel = {
  id: 'channel-1',
  ownerId: 'w3ds_sensitive-owner-identifier',
  handle: 'public-channel',
  name: 'Public channel',
  subscriberCount: 4,
  videoCount: 1,
  createdAt: '2026-09-04T00:00:00.000Z',
};

describe('public channel list route', () => {
  beforeEach(() => mocks.getCreatorVideoService.mockReset());

  it('never returns a platform owner identifier in public channel discovery', async () => {
    mocks.getCreatorVideoService.mockReturnValue({
      listPublicChannels: vi.fn().mockResolvedValue({ items: [channel] }),
    });

    const response = await GET(new NextRequest('https://vidak.example/api/channels/public'));
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.items[0]).toEqual({
      id: channel.id,
      handle: channel.handle,
      name: channel.name,
      subscriberCount: channel.subscriberCount,
      videoCount: channel.videoCount,
      createdAt: channel.createdAt,
    });
    expect(JSON.stringify(body)).not.toContain(channel.ownerId);
  });
});
