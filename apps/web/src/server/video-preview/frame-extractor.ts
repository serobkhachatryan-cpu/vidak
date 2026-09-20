import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { averageFrameLuma, isMostlyBlackFrame, previewCaptureCandidates } from './capture-time';

const sampleWidth = 160;
const sampleHeight = 90;
const extractTimeoutMs = 20_000;
const probeTimeoutMs = 12_000;

export type PreviewFrameSource =
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'bytes'; bytes: Uint8Array };

export interface ExtractedPreviewFrame {
  jpeg: Uint8Array;
  captureSeconds: number;
  /** Duration observed while probing the same source, when available. */
  durationSeconds?: number;
  /**
   * A genuine decoded frame that was too dark for the normal usefulness
   * threshold, but was retained as the best available source-derived poster.
   */
  kind?: 'dark-fallback';
}

export interface VideoFrameExtractor {
  extractUsefulFrame(
    source: PreviewFrameSource,
    options?: { signal?: AbortSignal },
  ): Promise<ExtractedPreviewFrame | undefined>;
  /**
   * Optional lightweight metadata probe. Implementations that cannot inspect
   * duration can omit it without making preview generation unavailable.
   */
  probeDuration?(source: PreviewFrameSource): Promise<number | undefined>;
}

export class VideoFrameExtractorError extends Error {
  constructor(
    message: string,
    /**
     * `retryable` means ffmpeg could not complete a read of the source. It is
     * deliberately distinct from a completed decode that produced no useful
     * frame: a short-lived eVault redirect, a connection timeout, or a
     * transient child-process failure deserves one bounded retry.
     */
    public readonly code: 'unavailable' | 'retryable' | 'failed',
  ) {
    super(message);
    this.name = 'VideoFrameExtractorError';
  }
}

/** Lets the preview queue retry only source-read failures, never bad frames. */
export function isRetryableVideoFrameExtractorError(
  error: unknown,
): error is VideoFrameExtractorError {
  return error instanceof VideoFrameExtractorError && error.code === 'retryable';
}

/**
 * Derives a JPEG still using the host `ffmpeg` / `ffprobe` already on PATH.
 * Does not install or download a binary.
 */
export class FfmpegVideoFrameExtractor implements VideoFrameExtractor {
  constructor(
    private readonly ffmpegPath = 'ffmpeg',
    private readonly ffprobePath = 'ffprobe',
  ) {}

  async extractUsefulFrame(
    source: PreviewFrameSource,
    options?: { signal?: AbortSignal },
  ): Promise<ExtractedPreviewFrame | undefined> {
    const workspace = await mkdtemp(join(tmpdir(), 'vidak-preview-'));
    try {
      const input = await this.materializeInput(source, workspace);
      const duration = await this.probeDurationForInput(input, options?.signal);
      if (options?.signal?.aborted) return undefined;
      const candidates = previewCaptureCandidates(duration ?? 0);
      let sawRetryableReadFailure = false;
      let brightestDarkCandidate: { captureSeconds: number; luma: number } | undefined;
      for (const captureSeconds of candidates) {
        const sample = await this.extractRgbSample(
          input,
          captureSeconds,
          workspace,
          options?.signal,
        );
        if (options?.signal?.aborted) return undefined;
        if (sample.kind === 'unavailable') {
          throw new VideoFrameExtractorError('Frame extraction is unavailable.', 'unavailable');
        }
        if (sample.kind === 'retryable') {
          if (sample.immediate) {
            throw new VideoFrameExtractorError(
              'Frame extraction could not read the source.',
              'retryable',
            );
          }
          sawRetryableReadFailure = true;
          continue;
        }
        if (sample.kind !== 'frame') {
          continue;
        }
        const luma = averageFrameLuma(sample.bytes, sampleWidth, sampleHeight);
        if (luma === undefined) continue;
        if (isMostlyBlackFrame(sample.bytes, sampleWidth, sampleHeight)) {
          if (!brightestDarkCandidate || luma > brightestDarkCandidate.luma) {
            brightestDarkCandidate = { captureSeconds, luma };
          }
          continue;
        }
        const jpeg = await this.extractJpeg(input, captureSeconds, workspace, options?.signal);
        if (options?.signal?.aborted) return undefined;
        if (jpeg.kind === 'unavailable') {
          throw new VideoFrameExtractorError('Frame extraction is unavailable.', 'unavailable');
        }
        if (jpeg.kind === 'retryable') {
          if (jpeg.immediate) {
            throw new VideoFrameExtractorError(
              'Frame extraction could not read the source.',
              'retryable',
            );
          }
          sawRetryableReadFailure = true;
          continue;
        }
        if (jpeg.kind === 'frame' && jpeg.bytes.byteLength) {
          return {
            jpeg: jpeg.bytes,
            captureSeconds,
            ...(duration !== undefined ? { durationSeconds: duration } : {}),
          };
        }
        // A successful RGB sample followed by no JPEG output is not evidence
        // that the video has no useful frame. Treat it like a transient local
        // write/decode failure and let the service make one bounded retry.
        sawRetryableReadFailure = true;
      }
      // A fully dark call/clip is still a real, decoded video frame. Keep the
      // brightest sample instead of collapsing it into the same unavailable
      // state as a source from which ffmpeg could not decode any frame at all.
      // This is deliberately after the useful-frame loop so a normal scene is
      // always preferred when one exists.
      if (brightestDarkCandidate) {
        const jpeg = await this.extractJpeg(
          input,
          brightestDarkCandidate.captureSeconds,
          workspace,
          options?.signal,
        );
        if (options?.signal?.aborted) return undefined;
        if (jpeg.kind === 'unavailable') {
          throw new VideoFrameExtractorError('Frame extraction is unavailable.', 'unavailable');
        }
        if (jpeg.kind === 'retryable') {
          if (jpeg.immediate) {
            throw new VideoFrameExtractorError(
              'Frame extraction could not read the source.',
              'retryable',
            );
          }
          sawRetryableReadFailure = true;
        } else if (jpeg.kind === 'frame' && jpeg.bytes.byteLength) {
          return {
            jpeg: jpeg.bytes,
            captureSeconds: brightestDarkCandidate.captureSeconds,
            kind: 'dark-fallback',
            ...(duration !== undefined ? { durationSeconds: duration } : {}),
          };
        } else {
          // RGB was decoded but JPEG emission failed. That is a transient
          // local/write failure, not proof that the original source has no
          // decodable video frame.
          sawRetryableReadFailure = true;
        }
      }
      if (sawRetryableReadFailure) {
        throw new VideoFrameExtractorError(
          'Frame extraction could not read the source.',
          'retryable',
        );
      }
      return undefined;
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async probeDuration(source: PreviewFrameSource): Promise<number | undefined> {
    const workspace = await mkdtemp(join(tmpdir(), 'vidak-preview-'));
    try {
      const input = await this.materializeInput(source, workspace);
      return this.probeDurationForInput(input);
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async materializeInput(source: PreviewFrameSource, workspace: string): Promise<string> {
    if (source.kind === 'path') return source.path;
    if (source.kind === 'url') return source.url;
    const path = join(workspace, 'source.bin');
    await writeFile(path, source.bytes);
    return path;
  }

  private async probeDurationForInput(
    input: string,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    try {
      const stdout = await runProcess(
        this.ffprobePath,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
        probeTimeoutMs,
        signal,
      );
      const duration = Number.parseFloat(stdout.trim());
      return Number.isFinite(duration) && duration > 0 ? duration : undefined;
    } catch {
      return undefined;
    }
  }

  private async extractRgbSample(
    input: string,
    captureSeconds: number,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<FrameAttempt> {
    const output = join(workspace, `sample-${captureSeconds}.rgb`);
    const result = await runProcessExit(
      this.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(captureSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale=${sampleWidth}:${sampleHeight}`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        output,
      ],
      extractTimeoutMs,
      signal,
    );
    if (result.kind !== 'ok') return result;
    try {
      const bytes = await readFile(output);
      return {
        kind: 'frame',
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      };
    } catch {
      return { kind: 'empty' };
    }
  }

  private async extractJpeg(
    input: string,
    captureSeconds: number,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<FrameAttempt> {
    const output = join(workspace, `poster-${captureSeconds}.jpg`);
    const result = await runProcessExit(
      this.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(captureSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:-2',
        '-q:v',
        '4',
        output,
      ],
      extractTimeoutMs,
      signal,
    );
    if (result.kind !== 'ok') return result;
    try {
      const bytes = await readFile(output);
      if (bytes.byteLength < 32) return { kind: 'empty' };
      return {
        kind: 'frame',
        bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      };
    } catch {
      return { kind: 'empty' };
    }
  }
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new VideoFrameExtractorError('Frame extraction was preempted.', 'failed'));
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      cleanup();
      reject(new VideoFrameExtractorError('Frame extraction timed out.', 'failed'));
    }, timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new VideoFrameExtractorError('Frame extraction was preempted.', 'failed'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      reject(
        new VideoFrameExtractorError(
          error instanceof Error ? error.message : 'Frame extraction is unavailable.',
          'unavailable',
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new VideoFrameExtractorError('Frame extraction failed.', 'failed'));
    });
  });
}

type ProcessExitResult =
  | { kind: 'ok' }
  | { kind: 'retryable'; immediate: boolean }
  | { kind: 'unavailable' }
  | { kind: 'aborted' };

type FrameAttempt =
  | { kind: 'frame'; bytes: Uint8Array }
  | { kind: 'empty' }
  | Exclude<ProcessExitResult, { kind: 'ok' }>;

function runProcessExit(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => undefined;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = (result: ProcessExitResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      resolve(result);
    };
    if (signal?.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (isUnavailableProcessError(code)) resolve({ kind: 'unavailable' });
      else resolve({ kind: 'retryable', immediate: true });
      return;
    }
    abort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The child can exit between the signal and this cancellation.
      }
      finish({ kind: 'aborted' });
    };
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The close handler still settles this attempt when the child won the race.
      }
      finish({ kind: 'retryable', immediate: true });
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (isUnavailableProcessError(code)) {
        finish({ kind: 'unavailable' });
        return;
      }
      finish({ kind: 'retryable', immediate: true });
    });
    child.on('close', (code) => {
      // A non-zero ffmpeg exit can come from an expired redirect, a transient
      // upstream transport failure, or a bad seek. Try every capture point
      // first, then surface a retryable read failure if none can succeed.
      finish(code === 0 ? { kind: 'ok' } : { kind: 'retryable', immediate: false });
    });
  });
}

function isUnavailableProcessError(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'EACCES';
}
