import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Opaque storage-key pattern: UUID (with optional `media_` prefix).
 * Rejects path separators and traversal sequences so keys cannot address
 * arbitrary filesystem locations.
 */
const SAFE_STORAGE_KEY =
  /^(?:media_)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Server-only blob storage adapter. Implementations map opaque storage keys
 * to durable bytes; keys must never be treated as user-supplied paths.
 */
export interface MediaStorage {
  /** Creates an opaque, path-safe storage key. */
  createStorageKey(): string;
  write(storageKey: string, data: Uint8Array): Promise<void>;
  read(storageKey: string): Promise<Uint8Array>;
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
 * Objects are stored as flat files under `rootDir` named by the opaque key.
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
