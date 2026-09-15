'use client';

/**
 * A normal navigation to a continuous recording replaces the library card
 * with the Watch page quickly. Start the *actual* opaque ticket request at
 * that navigation boundary and let the page join it, rather than starting a
 * separate shared-source authorization request on the card and another ticket
 * request after navigation. The ticket remains the only source-zero preflight
 * and never exposes a media URL.
 */

export interface RecordingTicketResult {
  playbackUrl?: string;
  errorCode?: unknown;
}

interface PreloadedRecordingTicket {
  promise: Promise<RecordingTicketResult>;
  expiresAt: number;
  adopted: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export interface PreloadedRecordingTicketHandle {
  promise: Promise<RecordingTicketResult>;
  /**
   * Removes this exact handoff after the Watch page has adopted it. A later
   * automatic player retry must always issue a new single-use ticket.
   */
  release: () => void;
}

// A preloaded ticket only needs to bridge the in-app route transition and the
// exact one-item lookup on the Watch page. Keep this far below the server's
// two-minute pending-ticket lifetime so abandoned clicks do not occupy the
// small client handoff map for long.
const preloadedTicketTtlMs = 30_000;
const maxPreloadedTickets = 4;
const opaqueRecordingPlaybackPath = /^\/api\/evault\/recordings\/[A-Za-z0-9_-]{43}$/;

const preloadedTickets = new Map<string, PreloadedRecordingTicket>();

/**
 * Starts one source-zero preflight/ticket request for an ordinary in-app
 * continuous-recording navigation. It deliberately does not use `keepalive`:
 * a long recording can have a request body larger than browser keepalive
 * limits. SPA navigation keeps this module and its in-flight promise alive.
 */
export function preloadContinuousRecordingTicket(streamIds: readonly string[]): void {
  const key = recordingTicketKey(streamIds);
  if (!key) return;
  prunePreloadedTickets();
  if (preloadedTickets.has(key)) return;
  if (preloadedTickets.size >= maxPreloadedTickets) return;

  const entry: PreloadedRecordingTicket = {
    promise: createContinuousRecordingTicket(streamIds),
    expiresAt: Date.now() + preloadedTicketTtlMs,
    adopted: false,
  };
  preloadedTickets.set(key, entry);
  entry.expiryTimer = setTimeout(() => expirePreloadedTicket(key, entry), preloadedTicketTtlMs);
}

/**
 * Joins a ticket started by the card click. This intentionally keeps the same
 * promise available until the adopting Watch effect finishes, which makes
 * React's development effect replay join the one ticket instead of issuing a
 * duplicate. `release` is idempotent and never removes a newer prefetch.
 */
export function takePreloadedContinuousRecordingTicket(
  streamIds: readonly string[],
): PreloadedRecordingTicketHandle | undefined {
  const key = recordingTicketKey(streamIds);
  if (!key) return undefined;
  prunePreloadedTickets();
  const entry = preloadedTickets.get(key);
  if (!entry) return undefined;
  // This happens before awaiting the request. The subsequent player mount can
  // be delayed, but once it has adopted this promise the ticket must remain
  // available for its media GET instead of being cleaned up on the preload TTL.
  entry.adopted = true;
  clearPreloadedTicketExpiry(entry);
  return {
    promise: entry.promise,
    release: () => {
      if (preloadedTickets.get(key) === entry) preloadedTickets.delete(key);
    },
  };
}

/** Creates a fresh single-use ticket when no card-click handoff is available. */
export async function createContinuousRecordingTicket(
  streamIds: readonly string[],
  signal?: AbortSignal,
): Promise<RecordingTicketResult> {
  const streamId = streamIds[0];
  if (!streamId) return { errorCode: 'invalid_recording' };
  try {
    const response = await fetch(
      `/api/evault/videos/${encodeURIComponent(streamId)}/recording-ticket`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ streamIds }),
        ...(signal ? { signal } : {}),
      },
    );
    const body = (await response.json().catch(() => undefined)) as
      | { playbackUrl?: unknown; error?: { code?: unknown } }
      | undefined;
    const playbackUrl = body?.playbackUrl;
    if (
      response.ok &&
      typeof playbackUrl === 'string' &&
      playbackUrl.startsWith('/api/evault/recordings/')
    ) {
      return { playbackUrl };
    }
    return { errorCode: body?.error?.code };
  } catch {
    return { errorCode: 'remote_unavailable' };
  }
}

export function resetRecordingTicketPreloadsForTests(): void {
  for (const entry of preloadedTickets.values()) clearPreloadedTicketExpiry(entry);
  preloadedTickets.clear();
}

function recordingTicketKey(streamIds: readonly string[]): string | undefined {
  if (
    !streamIds.length ||
    streamIds.some((streamId) => typeof streamId !== 'string' || !streamId)
  ) {
    return undefined;
  }
  // Stream IDs are opaque viewer-bound grants. This stays in browser memory
  // only; no value is put into a URL, DOM attribute, log, or persistent store.
  return streamIds.join('\u0000');
}

function prunePreloadedTickets(now = Date.now()): void {
  for (const [key, entry] of preloadedTickets) {
    if (entry.expiresAt <= now) expirePreloadedTicket(key, entry);
  }
}

function expirePreloadedTicket(key: string, entry: PreloadedRecordingTicket): void {
  if (preloadedTickets.get(key) !== entry || entry.adopted) return;
  preloadedTickets.delete(key);
  clearPreloadedTicketExpiry(entry);
  // The ticket request can still finish after navigation was abandoned. Wait
  // for that opaque result, then release only the unclaimed server ticket.
  void cancelAbandonedRecordingTicket(entry.promise);
}

function clearPreloadedTicketExpiry(entry: PreloadedRecordingTicket): void {
  if (entry.expiryTimer !== undefined) {
    clearTimeout(entry.expiryTimer);
    delete entry.expiryTimer;
  }
}

async function cancelAbandonedRecordingTicket(
  ticketPromise: Promise<RecordingTicketResult>,
): Promise<void> {
  const result = await ticketPromise;
  if (!result.playbackUrl || !opaqueRecordingPlaybackPath.test(result.playbackUrl)) return;
  try {
    await fetch(result.playbackUrl, {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'same-origin',
      // There is no body, so this fits the browser's keepalive limits and can
      // finish if the abandoned card is immediately replaced again.
      keepalive: true,
    });
  } catch {
    // The ticket's normal two-minute pending expiry remains the safe fallback.
  }
}
