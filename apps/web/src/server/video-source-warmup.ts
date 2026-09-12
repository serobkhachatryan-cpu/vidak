import 'server-only';

const sourceCacheTtlMs = 2 * 60_000;
const initialRangeBytes = 2 * 1024 * 1024;
const maxCachedBytes = 48 * 1024 * 1024;

interface CachedInitialRange {
  bytes: Uint8Array;
  contentType: string;
  expiresAt: number;
  totalBytes: number;
}

export interface CachedMediaRange {
  body: Uint8Array;
  contentRange: string;
  contentType: string;
}

const cachedInitialRanges = new Map<string, CachedInitialRange>();
let cachedBytes = 0;

/**
 * Caches at most the opening two MiB while the player is already receiving
 * that same authorized upstream response. The cache never delays playback or
 * opens another source connection. Entries are per-viewer, process-memory
 * only, globally bounded, and removed after two minutes.
 */
export function cacheInitialMediaRange(
  viewerKey: string,
  mediaUrl: string,
  body: ReadableStream<Uint8Array> | null,
  contentRange: string | null,
  contentType: string | null,
): ReadableStream<Uint8Array> | null {
  pruneExpiredRanges();
  const key = cacheKey(viewerKey, mediaUrl);
  if (cachedInitialRanges.has(key) || !body) return body;
  const upstreamRange = parseContentRange(contentRange);
  if (upstreamRange?.start !== 0) return body;

  const chunks: Uint8Array[] = [];
  let received = 0;
  let stored = false;
  const store = () => {
    if (stored || received === 0) return;
    const bytes = combineChunks(chunks, received);
    cacheInitialRange(key, {
      bytes,
      contentType: contentType ?? 'application/octet-stream',
      expiresAt: Date.now() + sourceCacheTtlMs,
      totalBytes: upstreamRange.total,
    });
    stored = true;
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (stored) return;
        const available = initialRangeBytes - received;
        if (available <= 0) {
          store();
          return;
        }
        const retained = chunk.byteLength > available ? chunk.slice(0, available) : chunk.slice();
        chunks.push(retained);
        received += retained.byteLength;
        if (received >= initialRangeBytes) store();
      },
      flush() {
        // Smaller opening responses are still useful for a later metadata
        // request, and retaining them does not wait for any extra source data.
        store();
      },
    }),
  );
}

/**
 * Returns an exact initial byte range when it is still resident in this
 * process. Range requests outside the cached opening bytes always fall back
 * to the authorized upstream proxy.
 */
export function getCachedMediaRange(
  viewerKey: string,
  mediaUrl: string,
  requestedRange: string | null,
): CachedMediaRange | undefined {
  pruneExpiredRanges();
  const key = cacheKey(viewerKey, mediaUrl);
  const cached = cachedInitialRanges.get(key);
  if (!cached) return undefined;
  // Promote an actively reused range so a busy library evicts cold entries
  // first while retaining the hard global memory bound.
  cachedInitialRanges.delete(key);
  cachedInitialRanges.set(key, cached);
  const request = parseRange(requestedRange, cached.totalBytes);
  // An open-ended request asks for the rest of the file. Returning only the
  // cache prefix would be an invalid partial answer that can make a native
  // video element retry or stall, so proxy it normally instead.
  if (!request || request.openEnded || request.end >= cached.bytes.byteLength) return undefined;
  const body = cached.bytes.slice(request.start, request.end + 1);
  return {
    body,
    contentRange: `bytes ${request.start}-${request.end}/${cached.totalBytes}`,
    contentType: cached.contentType,
  };
}

function combineChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cacheInitialRange(key: string, range: CachedInitialRange): void {
  deleteCachedRange(key);
  while (cachedBytes + range.bytes.byteLength > maxCachedBytes && cachedInitialRanges.size > 0) {
    const oldestKey = cachedInitialRanges.keys().next().value;
    if (!oldestKey) break;
    deleteCachedRange(oldestKey);
  }
  if (range.bytes.byteLength > maxCachedBytes) return;
  cachedInitialRanges.set(key, range);
  cachedBytes += range.bytes.byteLength;
}

function deleteCachedRange(key: string): void {
  const existing = cachedInitialRanges.get(key);
  if (!existing) return;
  cachedBytes -= existing.bytes.byteLength;
  cachedInitialRanges.delete(key);
}

function pruneExpiredRanges(now = Date.now()): void {
  for (const [key, range] of cachedInitialRanges) {
    if (range.expiresAt <= now) deleteCachedRange(key);
  }
}

function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return undefined;
  }
  return { start, end, total };
}

function parseRange(
  value: string | null,
  total: number,
): { start: number; end: number; openEnded: boolean } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const openEnded = !match[2];
  const end = openEnded ? total - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= total
  ) {
    return undefined;
  }
  return { start, end: Math.min(end, total - 1), openEnded };
}

function cacheKey(viewerKey: string, mediaUrl: string): string {
  // This key is never persisted or logged. Including the viewer prevents one
  // account from receiving bytes warmed for another account.
  return `${viewerKey}\0${mediaUrl}`;
}

export function resetVideoSourceWarmupsForTests(): void {
  cachedInitialRanges.clear();
  cachedBytes = 0;
}
