import { describe, expect, it } from 'vitest';
import { enqueuePreviewLoad, resetPreviewLoadQueueForTests } from './preview-load-queue';

describe('preview load queue', () => {
  it('runs one preview fetch at a time', async () => {
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
    expect(max).toBe(1);
    expect(running).toBe(1);
    release[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(max).toBe(1);
    for (const cancel of tasks) cancel();
    resetPreviewLoadQueueForTests();
  });
});
