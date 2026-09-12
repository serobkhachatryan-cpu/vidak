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
