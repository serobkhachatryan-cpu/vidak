import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VideoFrameExtractorError } from './frame-extractor';
import { FfmpegVideoFrameExtractor, isRetryableVideoFrameExtractorError } from './frame-extractor';

const temporaryDirectories: string[] = [];
const unixOnly = process.platform === 'win32' ? it.skip : it;

async function createExecutable(name: string, script: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vidak-frame-extractor-test-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, name);
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FfmpegVideoFrameExtractor failures', () => {
  unixOnly(
    'classifies a non-zero ffmpeg exit as retryable rather than an unavailable frame',
    async () => {
      const alwaysFails = await createExecutable('ffmpeg-fails', '#!/bin/sh\nexit 1\n');
      const extractor = new FfmpegVideoFrameExtractor(alwaysFails, alwaysFails);

      await expect(
        extractor.extractUsefulFrame({ kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) }),
      ).rejects.toSatisfy((error: unknown) => isRetryableVideoFrameExtractorError(error));
    },
  );

  unixOnly('keeps a missing ffmpeg binary terminally unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidak-frame-extractor-test-'));
    temporaryDirectories.push(directory);
    const missingBinary = join(directory, 'does-not-exist');
    const extractor = new FfmpegVideoFrameExtractor(missingBinary, missingBinary);

    await expect(
      extractor.extractUsefulFrame({ kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: 'unavailable' } satisfies Partial<VideoFrameExtractorError>);
  });

  unixOnly('classifies a transient spawn failure as retryable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidak-frame-extractor-test-'));
    temporaryDirectories.push(directory);
    const notADirectory = join(directory, 'not-a-directory');
    await writeFile(notADirectory, 'not a directory');
    const invalidExecutable = join(notADirectory, 'ffmpeg');
    const extractor = new FfmpegVideoFrameExtractor(invalidExecutable, invalidExecutable);

    await expect(
      extractor.extractUsefulFrame({ kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toSatisfy((error: unknown) => isRetryableVideoFrameExtractorError(error));
  });

  unixOnly('keeps the brightest completed dark frame as a source-derived fallback', async () => {
    const blackFrame = await createExecutable(
      'ffmpeg-black-frame',
      '#!/bin/sh\nlast=""\nfor argument in "$@"; do last="$argument"; done\ncase "$*" in\n  *rawvideo*) dd if=/dev/zero of="$last" bs=43200 count=1 2>/dev/null ;;\n  *) dd if=/dev/zero of="$last" bs=64 count=1 2>/dev/null ;;\nesac\nexit 0\n',
    );
    const duration = await createExecutable('ffprobe-duration', '#!/bin/sh\necho 20\n');
    const extractor = new FfmpegVideoFrameExtractor(blackFrame, duration);

    await expect(
      extractor.extractUsefulFrame({ kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) }),
    ).resolves.toMatchObject({ captureSeconds: 3, kind: 'dark-fallback', durationSeconds: 20 });
  });

  unixOnly('returns undefined when a completed decode produces no frame', async () => {
    const producesNoFrame = await createExecutable('ffmpeg-empty-frame', '#!/bin/sh\nexit 0\n');
    const extractor = new FfmpegVideoFrameExtractor(producesNoFrame, producesNoFrame);

    await expect(
      extractor.extractUsefulFrame({ kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) }),
    ).resolves.toBeUndefined();
  });

  it('keeps an explicitly cancelled extraction non-error', async () => {
    const controller = new AbortController();
    controller.abort();
    const extractor = new FfmpegVideoFrameExtractor('does-not-matter');

    await expect(
      extractor.extractUsefulFrame(
        { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) },
        { signal: controller.signal },
      ),
    ).resolves.toBeUndefined();
  });
});
