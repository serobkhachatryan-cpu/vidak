import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  cacheInitialMediaRange,
  getCachedMediaRange,
  resetVideoSourceWarmupsForTests,
} from './video-source-warmup';

afterEach(() => {
  resetVideoSourceWarmupsForTests();
});

describe('private video read-through cache', () => {
  it('forwards the player stream immediately and retains its opening bytes in RAM', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });

    const playerBody = cacheInitialMediaRange(
      '@viewer.w3id',
      'https://media.example/video.mp4',
      upstream,
      'bytes 0-3/9',
      'video/mp4',
    );

    expect([...new Uint8Array(await new Response(playerBody).arrayBuffer())]).toEqual([1, 2, 3, 4]);
    const cached = getCachedMediaRange(
      '@viewer.w3id',
      'https://media.example/video.mp4',
      'bytes=0-1',
    );
    expect(cached).toMatchObject({ contentRange: 'bytes 0-1/9', contentType: 'video/mp4' });
    expect([...(cached?.body ?? [])]).toEqual([1, 2]);
  });

  it('never serves one viewer bytes observed for another viewer', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const playerBody = cacheInitialMediaRange(
      '@one.w3id',
      'https://media.example/video.mp4',
      upstream,
      'bytes 0-2/3',
      'video/mp4',
    );
    await new Response(playerBody).arrayBuffer();

    expect(
      getCachedMediaRange('@one.w3id', 'https://media.example/video.mp4', 'bytes=0-2'),
    ).toBeDefined();
    expect(
      getCachedMediaRange('@two.w3id', 'https://media.example/video.mp4', 'bytes=0-2'),
    ).toBeUndefined();
  });

  it('does not truncate an open-ended native video range', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const playerBody = cacheInitialMediaRange(
      '@viewer.w3id',
      'https://media.example/video.mp4',
      upstream,
      'bytes 0-2/9',
      'video/mp4',
    );
    await new Response(playerBody).arrayBuffer();

    expect(
      getCachedMediaRange('@viewer.w3id', 'https://media.example/video.mp4', 'bytes=0-'),
    ).toBeUndefined();
  });

  it('does not retain a body whose source range does not begin at zero', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const playerBody = cacheInitialMediaRange(
      '@viewer.w3id',
      'https://media.example/video.mp4',
      upstream,
      'bytes 3-5/9',
      'video/mp4',
    );
    await new Response(playerBody).arrayBuffer();

    expect(
      getCachedMediaRange('@viewer.w3id', 'https://media.example/video.mp4', 'bytes=3-5'),
    ).toBeUndefined();
  });
});
