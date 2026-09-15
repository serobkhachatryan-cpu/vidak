import 'server-only';

/**
 * Private media is proxied through Vidak so signed source URLs never reach a
 * browser. This helper opens the startup phase of that proxy request;
 * callers retain ownership of the returned body stream. It does
 * buffer one initial media chunk before returning so a successful result
 * means that the source has actually started, not merely accepted headers.
 */

/**
 * A player is not meaningfully loading until private upstream response
 * headers *and* its first media byte have arrived.  Keeping that boundary
 * tight prevents a source that accepts a connection and then stalls from
 * trapping the browser behind a committed 200/206 response.
 */
export const defaultPrivateMediaHeaderTimeoutMs = 12_000;
export const maxPrivateMediaRedirects = 1;

/**
 * A File redirect may be a short-lived CDN URL. An eVault does not have to
 * expose its signing policy, so an unrecognised URL is deliberately useful
 * only for the opening/range burst that just resolved it; it is never treated
 * as a four-hour source merely because the playback grant lives that long.
 */
export const unknownPrivateMediaUrlCacheTtlMs = 15_000;
/** Leave time to start a range before an explicitly signed URL expires. */
export const privateMediaUrlExpirySafetyMarginMs = 15_000;
/** The cache caller can apply a tighter stream/grant bound. */
export const maxPrivateMediaUrlCacheTtlMs = 4 * 60 * 60 * 1000;

export type PrivateMediaUrlCacheExpiry =
  | {
      /** A recognised signed-URL expiry, minus the startup safety margin. */
      kind: 'explicit';
      ttlMs: number;
      expiresAt: number;
    }
  | {
      /** No portable expiry metadata: retain only the immediate range burst. */
      kind: 'unknown';
      ttlMs: number;
    };

export interface PrivateMediaUrlCacheExpiryOptions {
  /** Injectable for deterministic callers and tests. Milliseconds since epoch. */
  now?: number;
  /**
   * Caller-controlled ceiling, normally the remaining viewer stream/grant
   * lifetime. It can only reduce the result; it never extends a URL cache.
   */
  maxTtlMs?: number;
  /** Optional tighter bound for an unrecognised signed URL. */
  unknownTtlMs?: number;
  /** Optional conservative margin before an explicit URL expiration. */
  safetyMarginMs?: number;
}

export type PrivateMediaUpstreamFailure =
  | { kind: 'caller_cancelled' }
  | { kind: 'pre_header_timeout' }
  | { kind: 'pre_header_network' }
  | { kind: 'unsafe_initial_url' }
  | { kind: 'unsafe_redirect' }
  | { kind: 'missing_redirect' }
  | { kind: 'redirect_limit' }
  | { kind: 'upstream_status'; upstreamStatus: number };

type PrivateMediaUpstreamNonStatusFailureKind = Exclude<
  PrivateMediaUpstreamFailure['kind'],
  'upstream_status'
>;

export type PrivateMediaUpstreamSuccess = {
  kind: 'success';
  response: Response;
  /** Number of physical upstream HTTP requests, including redirect hops. */
  upstreamAttempts: number;
  redirectCount: number;
  /** Elapsed time until the final source has headers and a first media byte. */
  responseHeadersMs: number;
  /** Monotonic timestamp immediately before fetching the final response. */
  finalUpstreamStartedAt: number;
};

export type PrivateMediaUpstreamFailureResult = {
  kind: 'failure';
  failure: PrivateMediaUpstreamFailure;
  upstreamAttempts: number;
  redirectCount: number;
  responseHeadersMs: number;
};

export type PrivateMediaUpstreamResult =
  | PrivateMediaUpstreamSuccess
  | PrivateMediaUpstreamFailureResult;

export interface OpenPrivateMediaUpstreamInput {
  /** Server-resolved source URL. It is never returned or logged by this helper. */
  mediaUrl: string;
  /** The browser's byte range. No other request headers are forwarded upstream. */
  range?: string | null;
  /**
   * Aborts while opening the upstream response, including the first non-empty
   * media byte. Once this helper succeeds, the caller owns stream lifetime.
   */
  signal?: AbortSignal;
  /**
   * A single startup deadline shared by the initial request, its permitted
   * redirect, and the first non-empty media byte.
   */
  headerTimeoutMs?: number;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const refreshableStaleStatuses = new Set([401, 403, 404, 410]);

/**
 * Opens one server-side media source, with at most one manually validated
 * redirect. It deliberately returns a fixed, non-sensitive failure shape
 * instead of an upstream Error, Location, URL, or response body.
 */
export async function openPrivateMediaUpstream(
  input: OpenPrivateMediaUpstreamInput,
): Promise<PrivateMediaUpstreamResult> {
  const startedAt = performance.now();
  const initialUrl = parseSafePrivateMediaUpstreamUrl(input.mediaUrl);
  if (!initialUrl) {
    return failed('unsafe_initial_url', startedAt, 0, 0);
  }
  if (input.signal?.aborted) {
    return failed('caller_cancelled', startedAt, 0, 0);
  }

  const controller = new AbortController();
  let callerCancelled = false;
  let headerTimedOut = false;
  const abortForCaller = () => {
    callerCancelled = true;
    controller.abort();
  };
  input.signal?.addEventListener('abort', abortForCaller, { once: true });
  const timeout = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, normalizedHeaderTimeout(input.headerTimeoutMs));

  let currentUrl = initialUrl;
  let redirectCount = 0;
  let upstreamAttempts = 0;
  let finalUpstreamStartedAt = startedAt;
  try {
    while (true) {
      upstreamAttempts += 1;
      finalUpstreamStartedAt = performance.now();
      let response: Response;
      try {
        response = await fetch(currentUrl.toString(), {
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'manual',
          ...(input.range ? { headers: { Range: input.range } } : {}),
          signal: controller.signal,
        });
      } catch {
        if (callerCancelled || input.signal?.aborted) {
          return failed('caller_cancelled', startedAt, upstreamAttempts, redirectCount);
        }
        return failed(
          headerTimedOut ? 'pre_header_timeout' : 'pre_header_network',
          startedAt,
          upstreamAttempts,
          redirectCount,
        );
      }

      if (redirectStatuses.has(response.status)) {
        await discardUpstreamBody(response);
        if (redirectCount >= maxPrivateMediaRedirects) {
          return failed('redirect_limit', startedAt, upstreamAttempts, redirectCount);
        }
        const location = response.headers.get('location');
        if (!location) {
          return failed('missing_redirect', startedAt, upstreamAttempts, redirectCount);
        }
        const redirectedUrl = parseSafePrivateMediaUpstreamUrl(location, currentUrl);
        if (!redirectedUrl) {
          return failed('unsafe_redirect', startedAt, upstreamAttempts, redirectCount);
        }
        currentUrl = redirectedUrl;
        redirectCount += 1;
        continue;
      }

      if (response.ok || response.status === 206) {
        const preparedResponse = await prepareResponseForFirstMediaByte(
          response,
          controller.signal,
        );
        if (!preparedResponse) {
          return failed(
            headerTimedOut ? 'pre_header_timeout' : 'pre_header_network',
            startedAt,
            upstreamAttempts,
            redirectCount,
          );
        }
        return {
          kind: 'success',
          response: preparedResponse,
          upstreamAttempts,
          redirectCount,
          responseHeadersMs: elapsedMs(startedAt),
          finalUpstreamStartedAt,
        };
      }

      await discardUpstreamBody(response);
      return failed(
        { kind: 'upstream_status', upstreamStatus: response.status },
        startedAt,
        upstreamAttempts,
        redirectCount,
      );
    }
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abortForCaller);
  }
}

/**
 * Reads exactly one non-empty upstream chunk before a proxy route commits a
 * successful response. The returned Response prepends that chunk to a new
 * stream, so neither media bytes nor range semantics are lost. This is the
 * critical recovery boundary for sources that send headers promptly but then
 * never begin their body: callers can invalidate/renew once instead of
 * leaving the native player in a permanent loading state.
 */
async function prepareResponseForFirstMediaByte(
  response: Response,
  signal: AbortSignal,
): Promise<Response | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  try {
    const firstChunk = await readFirstNonEmptyChunk(reader, signal);
    if (!firstChunk) {
      await cancelReader(reader);
      return undefined;
    }
    const body = prependFirstChunk(reader, firstChunk);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    await cancelReader(reader);
    return undefined;
  }
}

async function readFirstNonEmptyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  while (true) {
    const result = await readWithAbort(reader, signal);
    if (result.done) return undefined;
    if (result.value.byteLength > 0) return result.value;
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error('Private media opening was aborted.'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Private media opening was aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function prependFirstChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstChunk: Uint8Array,
): ReadableStream<Uint8Array> {
  let firstChunkPending = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstChunkPending) {
        firstChunkPending = false;
        controller.enqueue(firstChunk);
        return;
      }
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            controller.close();
            return;
          }
          if (result.value.byteLength > 0) {
            controller.enqueue(result.value);
            return;
          }
        }
      } catch (error) {
        controller.error(error);
        await cancelReader(reader);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The upstream can close while a deadline or caller cancellation is
    // racing. It is already unusable at this point.
  }
}

/**
 * The route may resolve one fresh, viewer-authorized source for these
 * outcomes. It must still cap that refresh at one and never retry a stream
 * after final response headers have been returned.
 */
export function isRefreshablePrivateMediaFailure(failure: PrivateMediaUpstreamFailure): boolean {
  return (
    failure.kind === 'pre_header_timeout' ||
    failure.kind === 'pre_header_network' ||
    (failure.kind === 'upstream_status' && refreshableStaleStatuses.has(failure.upstreamStatus))
  );
}

/**
 * Chooses a safe cache lifetime for a canonical eVault File redirect without
 * making the cache depend on a particular storage provider. Recognised AWS,
 * Google, Azure SAS, CloudFront, and generic expiry parameters are bounded by
 * their actual deadline. A URL with no portable expiry evidence receives only
 * a very short burst cache, never the stream's normal multi-hour lifetime.
 *
 * `undefined` is intentionally fail-closed: it means a malformed recognised
 * expiry, an already-near-expiry URL, an unsafe URL, or invalid options. The
 * caller must not cache that source and should resolve it through its eVault
 * again for the next range.
 */
export function resolvePrivateMediaUrlCacheExpiry(
  mediaUrl: string,
  options: PrivateMediaUrlCacheExpiryOptions = {},
): PrivateMediaUrlCacheExpiry | undefined {
  const url = parseSafePrivateMediaUpstreamUrl(mediaUrl);
  const now = normalizeEpochMs(options.now ?? Date.now());
  const maxTtlMs = normalizePositiveTtl(options.maxTtlMs ?? maxPrivateMediaUrlCacheTtlMs);
  const unknownTtlMs = normalizePositiveTtl(
    options.unknownTtlMs ?? unknownPrivateMediaUrlCacheTtlMs,
  );
  const safetyMarginMs = normalizeNonNegativeTtl(
    options.safetyMarginMs ?? privateMediaUrlExpirySafetyMarginMs,
  );
  if (!url || now === undefined || maxTtlMs === undefined || unknownTtlMs === undefined) {
    return undefined;
  }
  if (safetyMarginMs === undefined) return undefined;

  const signedExpiry = signedUrlExpiry(url);
  if (signedExpiry.kind === 'invalid') return undefined;
  if (signedExpiry.kind === 'known') {
    const remainingMs = signedExpiry.expiresAt - now - safetyMarginMs;
    const ttlMs = Math.min(maxTtlMs, Math.floor(remainingMs));
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return undefined;
    return { kind: 'explicit', ttlMs, expiresAt: signedExpiry.expiresAt };
  }

  const ttlMs = Math.min(maxTtlMs, unknownTtlMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return undefined;
  return { kind: 'unknown', ttlMs };
}

/**
 * Neutral URL guard for server-only private-media transport. It intentionally
 * accepts neither HTTP nor literal local/private destinations. It performs no
 * DNS lookup, so callers that need DNS-rebinding resistance need a pinned or
 * allowlisted transport in addition to this syntactic guard.
 */
export function parseSafePrivateMediaUpstreamUrl(value: string, base?: URL): URL | undefined {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    return undefined;
  }
  return url;
}

async function discardUpstreamBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed redirect/error response has no useful media bytes. Continue
    // with the bounded outcome without exposing its body or error details.
  }
}

function failed(
  failure: PrivateMediaUpstreamFailure | PrivateMediaUpstreamNonStatusFailureKind,
  startedAt: number,
  upstreamAttempts: number,
  redirectCount: number,
): PrivateMediaUpstreamFailureResult {
  const normalizedFailure: PrivateMediaUpstreamFailure =
    typeof failure === 'string' ? { kind: failure } : failure;
  return {
    kind: 'failure',
    failure: normalizedFailure,
    upstreamAttempts,
    redirectCount,
    responseHeadersMs: elapsedMs(startedAt),
  };
}

function normalizedHeaderTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) return defaultPrivateMediaHeaderTimeoutMs;
  return Math.floor(value);
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b) || parts.some((part) => Number(part) > 255))
    return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  return (
    host === '::' ||
    host === '::1' ||
    /^fe[89ab][0-9a-f]:/.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  );
}

type SignedUrlExpiry =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'known'; expiresAt: number };

/**
 * Query parameters commonly used by signed object-storage URLs. All values
 * that look like an expiry must parse successfully; a malformed value is not
 * silently downgraded to the short unknown cache because that could still
 * retain a source beyond an unparseable short deadline.
 */
function signedUrlExpiry(url: URL): SignedUrlExpiry {
  const expirations: number[] = [];
  let hasExplicitExpiry = false;
  const addExpiry = (expiresAt: number | undefined): boolean => {
    hasExplicitExpiry = true;
    if (expiresAt === undefined) return false;
    expirations.push(expiresAt);
    return true;
  };
  const addDurationExpiry = (dateName: string, durationName: string): boolean => {
    const dates = queryParameterValues(url, dateName);
    const durations = queryParameterValues(url, durationName);
    if (dates.length === 0 && durations.length === 0) return true;
    hasExplicitExpiry = true;
    if (dates.length !== 1 || durations.length !== 1) return false;
    const [dateValue] = dates;
    const [durationValue] = durations;
    if (!dateValue || !durationValue) return false;
    const issuedAt = parseSigningTimestamp(dateValue);
    const durationMs = parseDurationSeconds(durationValue);
    if (issuedAt === undefined || durationMs === undefined) return false;
    return addExpiry(addEpochMs(issuedAt, durationMs));
  };

  // AWS Signature V4 and Google Cloud Storage V4 both bind expiry to the
  // signing timestamp plus a duration. Do not treat the duration as an epoch.
  if (!addDurationExpiry('x-amz-date', 'x-amz-expires')) return { kind: 'invalid' };
  if (!addDurationExpiry('x-goog-date', 'x-goog-expires')) return { kind: 'invalid' };

  // Azure SAS uses `se`; CloudFront and several object stores commonly use
  // an epoch in `Expires`; signed application URLs often use `exp`/`expiry`.
  for (const parameterName of ['expires', 'expiry', 'expiration', 'exp', 'se']) {
    for (const value of queryParameterValues(url, parameterName)) {
      if (!addExpiry(parseAbsoluteExpiry(value))) return { kind: 'invalid' };
    }
  }

  if (!hasExplicitExpiry) return { kind: 'none' };
  const expiresAt = Math.min(...expirations);
  return Number.isSafeInteger(expiresAt) ? { kind: 'known', expiresAt } : { kind: 'invalid' };
}

function queryParameterValues(url: URL, expectedName: string): string[] {
  const expected = expectedName.toLowerCase();
  const values: string[] = [];
  for (const [name, value] of url.searchParams) {
    if (name.toLowerCase() === expected) values.push(value);
  }
  return values;
}

function parseSigningTimestamp(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return undefined;
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  const parsed = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isSafeInteger(parsed)) return undefined;
  const date = new Date(parsed);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return parsed;
}

function parseDurationSeconds(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function parseAbsoluteExpiry(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) return undefined;
    // Unix seconds are currently ten digits. Treat an eleven-or-more digit
    // value as milliseconds instead of guessing a far-future seconds value.
    const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    return normalizeEpochMs(milliseconds);
  }
  // `se` is typically an ISO-8601 Azure SAS date. Keep this deliberately
  // strict: Date.parse accepts ambiguous locale forms that are unsafe here.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
  ) {
    return undefined;
  }
  return normalizeEpochMs(Date.parse(value));
}

function normalizeEpochMs(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
    ? value
    : undefined;
}

function normalizePositiveTtl(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 && Number.isSafeInteger(Math.floor(value))
    ? Math.floor(value)
    : undefined;
}

function normalizeNonNegativeTtl(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.floor(value))
    ? Math.floor(value)
    : undefined;
}

function addEpochMs(epochMs: number, durationMs: number): number | undefined {
  if (epochMs > Number.MAX_SAFE_INTEGER - durationMs) return undefined;
  return normalizeEpochMs(epochMs + durationMs);
}
