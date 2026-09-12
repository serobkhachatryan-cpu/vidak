import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { maxRecordingSegments } from './recording-concat-ticket';

const ffmpegPath = 'ffmpeg';
// Keep the pre-response buffer finite even if a broken process writes an
// endless init header or malformed boxes. A real fragmented-MP4 init segment
// and first `moof` are normally only a few KiB; this leaves ample room without
// turning a stalled source into unbounded per-viewer memory.
const maxRecordingConcatStartupBytes = 1 * 1024 * 1024;
/**
 * Do not leave the browser with a 200 after only FFmpeg's `empty_moov` init
 * header. That header is valid MP4 metadata but contains no playable media, so
 * a source that is stuck before its first packet otherwise looks like an
 * endless successful response. This is intentionally a startup boundary only:
 * after a real fragmented-MP4 media fragment begins, the rest remains fully
 * streaming.
 */
export const recordingConcatStartupTimeoutMs = 12_000;

export type RecordingConcatStartupFailureKind =
  | 'spawn_error'
  | 'exited_before_output'
  | 'startup_timeout';

export type RecordingConcatErrorCode = 'invalid_recording' | 'recording_unavailable';

/**
 * All messages in this error are safe to return to the authenticated browser.
 * In particular, never attach a child-process error: ffmpeg can include a
 * loopback capability URL in diagnostics.
 */
export class RecordingConcatError extends Error {
  constructor(
    message: string,
    public readonly code: RecordingConcatErrorCode = 'recording_unavailable',
    public readonly status = 503,
    public readonly startupFailureKind?: RecordingConcatStartupFailureKind,
  ) {
    super(message);
    this.name = 'RecordingConcatError';
  }
}

export interface RecordingConcatOptions {
  /** Releases the server-side playback ticket after ffmpeg has actually stopped. */
  onClose?: () => void | Promise<void>;
  /**
   * Server-side startup budget. This is deliberately not derived from request
   * input; callers may set it only in controlled tests or deployments.
   */
  startupTimeoutMs?: number;
}

/**
 * Turns the files that make up one call recording into a single fragmented
 * MP4 response. ffmpeg copies the original streams instead of re-encoding
 * them, so the response begins with the first source and crosses source
 * boundaries without making the browser load a new video element.
 *
 * The signed source URLs are written only to a mode-600 temporary concat file
 * and are removed as soon as ffmpeg exits. They are never put in a command
 * line, response, log, or browser-visible URL.
 */
export async function concatenateRecordingSources(
  mediaUrls: readonly string[],
  options: RecordingConcatOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  if (mediaUrls.length < 2 || mediaUrls.length > maxRecordingSegments) {
    throw new RecordingConcatError(
      `A recording must contain between two and ${maxRecordingSegments} sources.`,
      'invalid_recording',
      400,
    );
  }
  if (mediaUrls.some((url) => !isLoopbackMediaUrl(url))) {
    throw new RecordingConcatError('A recording source is unavailable.', 'invalid_recording', 400);
  }

  const startupTimeoutMs = resolveStartupTimeoutMs(options.startupTimeoutMs);
  const workspace = await mkdtemp(join(tmpdir(), 'vidak-recording-'));
  const concatList = join(workspace, 'sources.txt');
  let stopChild: (() => void) | undefined;
  try {
    await writeFile(concatList, mediaUrls.map(concatLine).join(''), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-rw_timeout',
        '60000000',
        '-f',
        'concat',
        '-safe',
        '0',
        '-protocol_whitelist',
        'file,http,https,tcp,tls',
        '-i',
        concatList,
        '-map',
        '0:v?',
        '-map',
        '0:a?',
        '-map',
        '0:s?',
        '-c',
        'copy',
        '-movflags',
        '+frag_keyframe+empty_moov+default_base_moof',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const lifecycle = createConcatChildLifecycle(child, workspace, options.onClose);
    stopChild = lifecycle.stopChild;
    if (!child.stdout) {
      lifecycle.stopChild();
      throw startupFailure('spawn_error');
    }

    const nodeStream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const reader = nodeStream.getReader();
    const startupChunks = await waitForFirstMediaFragment(
      reader,
      child,
      lifecycle.stopChild,
      startupTimeoutMs,
    );
    return toCancelableWebStream(reader, startupChunks, lifecycle.stopChild);
  } catch (error) {
    stopChild?.();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof RecordingConcatError) throw error;
    throw startupFailure('spawn_error');
  }
}

/**
 * `Readable.toWeb` cancels only stdout. A browser navigation can otherwise
 * leave ffmpeg alive, continuously fetching a private source after the user
 * has stopped watching. Bridge cancellation to the process and defer ticket
 * cleanup until its exit. The verified startup prefix is held only until the
 * browser pulls it; this makes the HTTP success boundary truthful without
 * buffering the recording.
 */
function toCancelableWebStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  startupChunks: readonly Uint8Array[],
  stopChild: () => void,
): ReadableStream<Uint8Array> {
  let nextStartupChunk = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (nextStartupChunk < startupChunks.length) {
        const chunk = startupChunks[nextStartupChunk];
        nextStartupChunk += 1;
        if (chunk) controller.enqueue(chunk);
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          // stdout ending while the child is still alive is not useful to the
          // player and could otherwise leave a private loopback fetch running.
          stopChild();
          return;
        }
        if (result.value.byteLength > 0) controller.enqueue(result.value);
      } catch {
        stopChild();
        controller.error(
          new RecordingConcatError('This recording stopped unexpectedly. Please retry.'),
        );
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        stopChild();
      }
    },
  });
}

function createConcatChildLifecycle(
  child: ReturnType<typeof spawn>,
  workspace: string,
  onClose: (() => void | Promise<void>) | undefined,
): { stopChild: () => void } {
  let cleaned = false;
  let childClosed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let stopRequested = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (killTimer) clearTimeout(killTimer);
    void rm(workspace, { recursive: true, force: true });
    try {
      void Promise.resolve(onClose?.()).catch(() => undefined);
    } catch {
      // Ticket cleanup is best-effort and must never crash a media response.
    }
  };
  const stopChild = () => {
    if (stopRequested || childClosed || child.exitCode !== null) return;
    stopRequested = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // A process can exit between the check and kill. The close handler will
      // still perform cleanup when Node observes it.
    }
    killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process exited concurrently.
        }
      }
    }, 5_000);
    killTimer.unref?.();
  };
  // Attach these before waiting on stdout. A missing executable can emit an
  // asynchronous child error before stdout ever becomes readable.
  child.once('close', () => {
    childClosed = true;
    cleanup();
  });
  child.once('error', cleanup);
  return { stopChild };
}

/**
 * Holds a small startup prefix before headers commit, and requires a complete
 * top-level `moof` followed by an `mdat` payload byte. FFmpeg emits an
 * `empty_moov` header before source media arrives; treating that header (or
 * arbitrary non-empty stdout) as success creates a misleading 200 which can
 * load forever. Every held chunk is returned verbatim once the stream starts.
 */
function waitForFirstMediaFragment(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  child: ReturnType<typeof spawn>,
  stopChild: () => void,
  timeoutMs: number,
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let startupBytes = 0;
    const startupChunks: Uint8Array[] = [];
    const fragmentDetector = new FragmentedMp4StartupDetector();
    const finish = () => {
      if (timeout) clearTimeout(timeout);
      child.off('error', onChildError);
      child.off('close', onChildClose);
    };
    const fail = (kind: RecordingConcatStartupFailureKind) => {
      if (settled) return;
      settled = true;
      finish();
      // Cancel only the local reader; the lifecycle handles the child and its
      // delayed close. Do not await this: a broken stdout must not extend the
      // bounded startup failure path.
      void reader.cancel().catch(() => undefined);
      stopChild();
      reject(startupFailure(kind));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      finish();
      resolve(startupChunks);
    };
    const onChildError = () => fail('spawn_error');
    const onChildClose = () => fail('exited_before_output');
    const readNext = () => {
      void reader.read().then(
        (result) => {
          if (settled) return;
          if (result.done) {
            fail('exited_before_output');
          } else if (result.value.byteLength > 0) {
            startupBytes += result.value.byteLength;
            if (startupBytes > maxRecordingConcatStartupBytes) {
              // Keep the established public failure taxonomy intentionally
              // coarse and sanitized. To the browser, unbounded malformed
              // pre-media output is equivalent to no usable media output.
              fail('exited_before_output');
              return;
            }
            startupChunks.push(result.value);
            const probe = fragmentDetector.push(result.value);
            if (probe === 'ready') {
              succeed();
            } else if (probe === 'invalid') {
              fail('exited_before_output');
            } else {
              readNext();
            }
          } else {
            readNext();
          }
        },
        () => fail('exited_before_output'),
      );
    };

    child.once('error', onChildError);
    child.once('close', onChildClose);
    timeout = setTimeout(() => fail('startup_timeout'), timeoutMs);
    timeout.unref?.();
    readNext();
  });
}

type FragmentProbeResult = 'ready' | 'pending' | 'invalid';

type Mp4BoxHeader =
  | { state: 'complete'; type: string; headerLength: number; length?: number }
  | { state: 'incomplete' }
  | { state: 'invalid' };

/**
 * Incrementally recognises the first actual fMP4 media fragment without
 * changing the byte stream. A `moof` is required to be complete, then an
 * `mdat` needs a valid header plus at least one payload byte. That is enough
 * to prove that FFmpeg has emitted media while avoiding a wait for an entire
 * (potentially large) video sample. `pending` contains only bytes that cannot
 * yet be classified as a complete top-level box.
 */
class FragmentedMp4StartupDetector {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private sawCompleteMoof = false;

  push(chunk: Uint8Array): FragmentProbeResult {
    this.pending = appendBytes(this.pending, chunk);
    let offset = 0;

    while (this.pending.byteLength - offset >= 8) {
      const header = readMp4BoxHeader(this.pending, offset);
      if (header.state === 'incomplete') break;
      if (header.state === 'invalid') return 'invalid';

      const bytesAvailable = this.pending.byteLength - offset;
      if (header.type === 'mdat' && this.sawCompleteMoof) {
        // `mdat` uses raw media bytes. Seeing one payload byte after its
        // header is sufficient to prove this is not only `empty_moov`.
        // A finite `mdat` declared to be header-only has no media payload;
        // bytes belonging to a later box must not be mistaken for one.
        if (header.length !== undefined && header.length <= header.headerLength) {
          return 'invalid';
        }
        if (bytesAvailable >= header.headerLength + 1) return 'ready';
        break;
      }

      // A zero-length box extends to EOF, so it cannot be completed during an
      // ongoing startup stream (except the mdat case handled above).
      if (header.length === undefined) break;
      if (bytesAvailable < header.length) break;

      if (header.type === 'moof') this.sawCompleteMoof = true;
      offset += header.length;
    }

    if (offset > 0) this.pending = this.pending.slice(offset);
    return 'pending';
  }
}

function readMp4BoxHeader(bytes: Uint8Array, offset: number): Mp4BoxHeader {
  const available = bytes.byteLength - offset;
  if (available < 8) return { state: 'incomplete' };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(offset);
  const type = String.fromCharCode(
    bytes[offset + 4] ?? 0,
    bytes[offset + 5] ?? 0,
    bytes[offset + 6] ?? 0,
    bytes[offset + 7] ?? 0,
  );

  if (size32 === 0) return { state: 'complete', type, headerLength: 8 };
  if (size32 !== 1) {
    if (size32 < 8) return { state: 'invalid' };
    return { state: 'complete', type, headerLength: 8, length: size32 };
  }

  if (available < 16) return { state: 'incomplete' };
  const size64 = view.getBigUint64(offset + 8);
  if (size64 < 16n || size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { state: 'invalid' };
  }
  return {
    state: 'complete',
    type,
    headerLength: 16,
    length: Number(size64),
  };
}

function appendBytes(
  first: Uint8Array<ArrayBufferLike>,
  second: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (first.byteLength === 0) return second.slice();
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first);
  combined.set(second, first.byteLength);
  return combined;
}

function resolveStartupTimeoutMs(value: number | undefined): number {
  if (value === undefined) return recordingConcatStartupTimeoutMs;
  // This option is server-side only. Keep the test/deployment escape hatch
  // bounded so a future caller cannot accidentally recreate an endless load.
  if (!Number.isFinite(value) || value <= 0 || value > 30_000) {
    throw new RecordingConcatError('The recording service is unavailable. Please retry.');
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    throw new RecordingConcatError('The recording service is unavailable. Please retry.');
  }
  return normalized;
}

function startupFailure(kind: RecordingConcatStartupFailureKind): RecordingConcatError {
  return new RecordingConcatError(
    'This recording could not start. Please retry.',
    'recording_unavailable',
    503,
    kind,
  );
}

function isLoopbackMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

function concatLine(url: string): string {
  // FFmpeg concat files use single quoted paths. Escape the only character
  // with special meaning in that representation without ever invoking a shell.
  return `file '${url.replaceAll("'", "'\\\\''")}'\n`;
}
