import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Opaque storage-key pattern: UUID (with optional `media_` prefix).
 * Rejects path separators and traversal sequences so keys cannot address
 * arbitrary filesystem locations.
 */
const SAFE_STORAGE_KEY =
  /^(?:media_)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Streaming upload handle: bytes land in private temporary storage until
 * `finalize` atomically promotes them to a durable object key.
 */
export interface MediaUploadSession {
  readonly tempKey: string;
  readonly bytesWritten: number;
  write(chunk: Uint8Array): Promise<void>;
  /** Atomically promote the temporary object to `storageKey`. */
  finalize(storageKey: string): Promise<void>;
  /** Discard the temporary object without promoting it. */
  abort(): Promise<void>;
}

/** Inclusive byte offsets for a partial object read (HTTP Range). */
export interface MediaReadRange {
  start: number;
  end: number;
}

/**
 * Server-only blob storage adapter. Implementations map opaque storage keys
 * to durable bytes; keys must never be treated as user-supplied paths.
 */
export interface MediaStorage {
  /** Creates an opaque, path-safe storage key. */
  createStorageKey(): string;
  write(storageKey: string, data: Uint8Array): Promise<void>;
  read(storageKey: string): Promise<Uint8Array>;
  /** Opens a private temporary upload that must be finalized or aborted. */
  openUpload(): Promise<MediaUploadSession>;
  /**
   * Streams object bytes without loading the whole object into memory.
   * When `range` is set, only the inclusive `[start, end]` slice is streamed.
   */
  openReadStream(storageKey: string, range?: MediaReadRange): Promise<ReadableStream<Uint8Array>>;
  delete(storageKey: string): Promise<void>;
  exists(storageKey: string): Promise<boolean>;
}

export class MediaStorageError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_storage_key' | 'not_found' | 'internal_error',
  ) {
    super(message);
    this.name = 'MediaStorageError';
  }
}

/** Validates that a storage key is opaque and cannot traverse the filesystem. */
export function assertSafeStorageKey(storageKey: string): void {
  if (typeof storageKey !== 'string' || !storageKey) {
    throw new MediaStorageError('Storage key is required.', 'invalid_storage_key');
  }
  if (
    storageKey.includes('/') ||
    storageKey.includes('\\') ||
    storageKey.includes('..') ||
    storageKey.includes('\0') ||
    !SAFE_STORAGE_KEY.test(storageKey)
  ) {
    throw new MediaStorageError(
      'Storage key must be an opaque identifier and cannot contain path segments.',
      'invalid_storage_key',
    );
  }
}

/**
 * Private local-disk MediaStorage for development and unit tests.
 * Final objects are flat files under `rootDir` named by the opaque key.
 * In-flight uploads use a private `.uploads/` staging directory.
 */
export class LocalDiskMediaStorage implements MediaStorage {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    const trimmed = rootDir.trim();
    if (!trimmed) {
      throw new MediaStorageError('Media storage root directory is required.', 'internal_error');
    }
    this.rootDir = resolve(trimmed);
  }

  createStorageKey(): string {
    return `media_${randomUUID()}`;
  }

  async write(storageKey: string, data: Uint8Array): Promise<void> {
    const path = this.resolveObjectPath(storageKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async read(storageKey: string): Promise<Uint8Array> {
    const path = this.resolveObjectPath(storageKey);
    try {
      const bytes = await readFile(path);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new MediaStorageError('Media object was not found.', 'not_found');
      }
      throw error;
    }
  }

  async openUpload(): Promise<MediaUploadSession> {
    const tempKey = this.createStorageKey();
    const tempPath = this.resolveTempPath(tempKey);
    await mkdir(dirname(tempPath), { recursive: true });
    const handle = await open(tempPath, 'w');
    let bytesWritten = 0;
    let settled = false;

    return {
      tempKey,
      get bytesWritten() {
        return bytesWritten;
      },
      write: async (chunk: Uint8Array) => {
        if (settled) {
          throw new MediaStorageError('Upload session is already closed.', 'internal_error');
        }
        if (chunk.byteLength === 0) return;
        await handle.write(chunk);
        bytesWritten += chunk.byteLength;
      },
      finalize: async (storageKey: string) => {
        if (settled) {
          throw new MediaStorageError('Upload session is already closed.', 'internal_error');
        }
        settled = true;
        try {
          await handle.close();
          const finalPath = this.resolveObjectPath(storageKey);
          await mkdir(dirname(finalPath), { recursive: true });
          await rename(tempPath, finalPath);
        } catch (error) {
          await rm(tempPath, { force: true }).catch(() => undefined);
          throw error;
        }
      },
      abort: async () => {
        if (settled) return;
        settled = true;
        await handle.close().catch(() => undefined);
        await rm(tempPath, { force: true }).catch(() => undefined);
      },
    };
  }

  async openReadStream(
    storageKey: string,
    range?: MediaReadRange,
  ): Promise<ReadableStream<Uint8Array>> {
    const path = this.resolveObjectPath(storageKey);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new MediaStorageError('Media object was not found.', 'not_found');
      }
      throw error;
    }
    if (range) {
      if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end >= info.size
      ) {
        throw new MediaStorageError('Media object was not found.', 'not_found');
      }
      const nodeStream = createReadStream(path, { start: range.start, end: range.end });
      return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    }
    const nodeStream = createReadStream(path);
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async delete(storageKey: string): Promise<void> {
    const path = this.resolveObjectPath(storageKey);
    try {
      await rm(path, { force: true });
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    const path = this.resolveObjectPath(storageKey);
    try {
      const info = await stat(path);
      return info.isFile();
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  /** Absolute path for a validated key; exported for tests only via resolve. */
  resolveObjectPath(storageKey: string): string {
    return this.resolveUnderRoot(storageKey);
  }

  /** Absolute path for a validated temporary upload key (staging area). */
  resolveTempPath(tempKey: string): string {
    assertSafeStorageKey(tempKey);
    const uploadsRoot = resolve(this.rootDir, '.uploads');
    const resolvedUploadsRoot = uploadsRoot.endsWith(sep) ? uploadsRoot : `${uploadsRoot}${sep}`;
    const resolved = resolve(uploadsRoot, tempKey);
    if (resolved !== uploadsRoot && !resolved.startsWith(resolvedUploadsRoot)) {
      throw new MediaStorageError(
        'Storage key must be an opaque identifier and cannot contain path segments.',
        'invalid_storage_key',
      );
    }
    return resolved;
  }

  private resolveUnderRoot(storageKey: string): string {
    assertSafeStorageKey(storageKey);
    const resolvedRoot = this.rootDir.endsWith(sep) ? this.rootDir : `${this.rootDir}${sep}`;
    const resolved = resolve(this.rootDir, storageKey);
    if (resolved !== this.rootDir && !resolved.startsWith(resolvedRoot)) {
      throw new MediaStorageError(
        'Storage key must be an opaque identifier and cannot contain path segments.',
        'invalid_storage_key',
      );
    }
    return resolved;
  }
}

/** Development helper: local disk root from MEDIA_STORAGE_ROOT or a default. */
export function resolveLocalMediaStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MEDIA_STORAGE_ROOT?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(process.cwd(), '.data', 'media');
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
