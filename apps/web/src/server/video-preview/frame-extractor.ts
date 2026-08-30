import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMostlyBlackFrame, previewCaptureCandidates } from './capture-time';

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
}

export interface VideoFrameExtractor {
  extractUsefulFrame(source: PreviewFrameSource): Promise<ExtractedPreviewFrame | undefined>;
}

export class VideoFrameExtractorError extends Error {
  constructor(
    message: string,
    public readonly code: 'unavailable' | 'failed',
  ) {
    super(message);
    this.name = 'VideoFrameExtractorError';
  }
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

  async extractUsefulFrame(source: PreviewFrameSource): Promise<ExtractedPreviewFrame | undefined> {
    const workspace = await mkdtemp(join(tmpdir(), 'vidak-preview-'));
    try {
      const input = await this.materializeInput(source, workspace);
      const duration = await this.probeDuration(input);
      const candidates = previewCaptureCandidates(duration ?? 0);
      for (const captureSeconds of candidates) {
        const sample = await this.extractRgbSample(input, captureSeconds, workspace);
        if (!sample || isMostlyBlackFrame(sample, sampleWidth, sampleHeight)) continue;
        const jpeg = await this.extractJpeg(input, captureSeconds, workspace);
        if (jpeg?.byteLength) return { jpeg, captureSeconds };
      }
      return undefined;
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

  private async probeDuration(input: string): Promise<number | undefined> {
    try {
      const stdout = await runProcess(
        this.ffprobePath,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
        probeTimeoutMs,
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
  ): Promise<Uint8Array | undefined> {
    const output = join(workspace, `sample-${captureSeconds}.rgb`);
    const ok = await runProcessExit(
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
    );
    if (!ok) return undefined;
    try {
      const bytes = await readFile(output);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch {
      return undefined;
    }
  }

  private async extractJpeg(
    input: string,
    captureSeconds: number,
    workspace: string,
  ): Promise<Uint8Array | undefined> {
    const output = join(workspace, `poster-${captureSeconds}.jpg`);
    const ok = await runProcessExit(
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
    );
    if (!ok) return undefined;
    try {
      const bytes = await readFile(output);
      if (bytes.byteLength < 32) return undefined;
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch {
      return undefined;
    }
  }
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new VideoFrameExtractorError('Frame extraction timed out.', 'failed'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        new VideoFrameExtractorError(
          error instanceof Error ? error.message : 'Frame extraction is unavailable.',
          'unavailable',
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new VideoFrameExtractorError('Frame extraction failed.', 'failed'));
    });
  });
}

function runProcessExit(command: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
