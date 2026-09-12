import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { concatenateRecordingSources, RecordingConcatError } from './recording-concat';

describe('recording concat', () => {
  it('accepts only loopback segment endpoints, never a direct private media URL', async () => {
    await expect(
      concatenateRecordingSources([
        'https://media.example/private-1.mp4',
        'https://media.example/private-2.mp4',
      ]),
    ).rejects.toBeInstanceOf(RecordingConcatError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('waits for a complete fMP4 media fragment, then preserves every startup byte', async () => {
    mocks.spawn.mockReset();
    const child = concatChild();
    const init = concatBytes(mp4Box('ftyp', Uint8Array.of(1)), mp4Box('moov'));
    const fragment = concatBytes(
      mp4Box('moof', Uint8Array.of(2)),
      mp4Box('mdat', Uint8Array.of(3)),
    );
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(init);
        child.stdout.write(fragment);
        child.stdout.end();
      });
      return child;
    });

    const stream = await concatenateRecordingSources(loopbackSources());
    expect(await readAll(stream)).toEqual(concatBytes(init, fragment));
    child.emit('close');
  });

  it('waits across split MP4 atoms instead of accepting an incomplete fragment', async () => {
    mocks.spawn.mockReset();
    const child = concatChild();
    const init = concatBytes(mp4Box('ftyp'), mp4Box('moov'));
    const fragment = concatBytes(
      mp4Box('moof', Uint8Array.of(9)),
      mp4Box('mdat', Uint8Array.of(8, 7)),
    );
    const splitAt = init.byteLength + mp4Box('moof', Uint8Array.of(9)).byteLength + 5;
    const output = concatBytes(init, fragment);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(output.slice(0, splitAt));
        queueMicrotask(() => {
          child.stdout.write(output.slice(splitAt));
          child.stdout.end();
        });
      });
      return child;
    });

    const stream = await concatenateRecordingSources(loopbackSources());
    expect(await readAll(stream)).toEqual(output);
    child.emit('close');
  });

  it('terminates ffmpeg and releases the ticket when the browser cancels playback', async () => {
    mocks.spawn.mockReset();
    const child = concatChild();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(validFragmentedMp4Startup());
      });
      return child;
    });
    const release = vi.fn();

    const stream = await concatenateRecordingSources(loopbackSources(), { onClose: release });
    const reader = stream.getReader();
    await reader.cancel('viewer navigated away');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails with a sanitized 503 when ffmpeg cannot be spawned', async () => {
    mocks.spawn.mockReset();
    const child = concatChild();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit(
          'error',
          new Error('spawn ffmpeg ENOENT http://127.0.0.1:3910/private?key=must-not-leak'),
        );
      });
      return child;
    });
    const release = vi.fn();

    await expect(
      concatenateRecordingSources(loopbackSources(), { onClose: release }),
    ).rejects.toMatchObject({
      code: 'recording_unavailable',
      status: 503,
      startupFailureKind: 'spawn_error',
      message: 'This recording could not start. Please retry.',
    });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails before a browser response when ffmpeg exits without media output', async () => {
    mocks.spawn.mockReset();
    const child = concatChild();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });

    await expect(concatenateRecordingSources(loopbackSources())).rejects.toMatchObject({
      code: 'recording_unavailable',
      status: 503,
      startupFailureKind: 'exited_before_output',
    });
  });

  it('bounds a no-output ffmpeg startup instead of leaving an endless media response', async () => {
    mocks.spawn.mockReset();
    const child = concatChild();
    mocks.spawn.mockReturnValue(child);

    await expect(
      concatenateRecordingSources(loopbackSources(), { startupTimeoutMs: 10 }),
    ).rejects.toMatchObject({
      code: 'recording_unavailable',
      status: 503,
      startupFailureKind: 'startup_timeout',
    });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
  });

  it('times out on an init header without a media fragment instead of returning a 200 stream', async () => {
    mocks.spawn.mockReset();
    const child = concatChild();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.write(concatBytes(mp4Box('ftyp'), mp4Box('moov')));
      });
      return child;
    });

    await expect(
      concatenateRecordingSources(loopbackSources(), { startupTimeoutMs: 10 }),
    ).rejects.toMatchObject({
      code: 'recording_unavailable',
      status: 503,
      startupFailureKind: 'startup_timeout',
      message: 'This recording could not start. Please retry.',
    });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
  });
});

function loopbackSources(): string[] {
  return [
    'http://127.0.0.1:3910/api/evault/recordings/ticket/segments/0?key=secret',
    'http://127.0.0.1:3910/api/evault/recordings/ticket/segments/1?key=secret',
  ];
}

function concatChild() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(),
    stdout: new PassThrough(),
  });
}

function validFragmentedMp4Startup(): Uint8Array {
  return concatBytes(
    mp4Box('ftyp', Uint8Array.of(1)),
    mp4Box('moov'),
    mp4Box('moof', Uint8Array.of(2)),
    mp4Box('mdat', Uint8Array.of(3)),
  );
}

function mp4Box(type: string, payload = new Uint8Array()): Uint8Array {
  if (type.length !== 4) throw new Error('MP4 box types must be four characters.');
  const box = new Uint8Array(8 + payload.byteLength);
  new DataView(box.buffer, box.byteOffset, box.byteLength).setUint32(0, box.byteLength);
  for (let index = 0; index < type.length; index += 1) {
    box[index + 4] = type.charCodeAt(index);
  }
  box.set(payload, 8);
  return box;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) return concatBytes(...chunks);
    chunks.push(result.value);
  }
}
