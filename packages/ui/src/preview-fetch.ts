export const previewFetchTimeoutMs = 15_000;

type PreviewFetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface PreviewFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetcher?: PreviewFetcher;
}

/**
 * A poster request must not occupy the serialized preview queue indefinitely.
 * The caller may also cancel it early when its card is no longer relevant.
 */
export async function fetchPreviewWithTimeout(
  posterUrl: string,
  {
    timeoutMs = previewFetchTimeoutMs,
    signal,
    fetcher = (input, init) => fetch(input, init),
  }: PreviewFetchOptions = {},
): Promise<Response> {
  const requestController = new AbortController();
  const cancelFromCaller = () => requestController.abort();
  const timeout = setTimeout(() => requestController.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) requestController.abort();
    else signal.addEventListener('abort', cancelFromCaller, { once: true });
  }

  try {
    return await fetcher(posterUrl, { cache: 'no-store', signal: requestController.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancelFromCaller);
  }
}
