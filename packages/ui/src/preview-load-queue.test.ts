import { describe, expect, it } from 'vitest';
import { enqueuePreviewLoad, resetPreviewLoadQueueForTests } from './preview-load-queue';

describe('preview load queue', () => {
  it('runs at most three preview fetches at once', async () => {
    resetPreviewLoadQueueForTests();
    let running = 0;
    let max = 0;
    const release: Array<() => void> = [];
    const tasks = Array.from({ length: 5 }, () =>
      enqueuePreviewLoad(
        () =>
          new Promise<void>((resolve) => {
            running += 1;
            max = Math.max(max, running);
            release.push(() => {
              running -= 1;
              resolve();
            });
          }),
      ),
    );
    await Promise.resolve();
    expect(max).toBe(3);
    expect(running).toBe(3);
    release[0]?.();
    release[1]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(max).toBe(3);
    for (const cancel of tasks) cancel();
    resetPreviewLoadQueueForTests();
  });
});
