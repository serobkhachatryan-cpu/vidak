import { createHash, createHmac, randomBytes } from 'node:crypto';
import 'server-only';

import { parseSafePrivateMediaUpstreamUrl } from './private-media-upstream';

/**
 * The source route is intentionally a narrow server-to-server capability. It
 * replaces the slow legacy Chat/history scan only when Vidak already holds an
 * exact viewer Chat grant and canonical CallSession in its sealed stream grant.
 */
export const meshengerPlaybackGrantPath = '/api/integrations/vidak/recording-playback-grant';
export const meshengerPlaybackGrantRequestTimeoutMs = 3_000;
export const meshengerPlaybackGrantMaxCacheMs = 2 * 60_000;

export interface MeshengerPlaybackGrantConfig {
  endpoint: string;
  secret: string;
}

export interface MeshengerPlaybackGrantRequest {
  viewerEName: string;
  viewerChatGrantId: string;
  callSessionVault: string;
  callSessionEnvelopeId: string;
  sourceChatId: string;
  fileUri: string;
}

export type MeshengerPlaybackGrantResult =
  | { kind: 'granted'; mediaUrl: string; expiresAt: number }
  | { kind: 'not_configured' }
  | { kind: 'not_eligible' }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | { kind: 'rejected' }
  | { kind: 'cancelled' };

/**
 * Bridge configuration is opt-in. The new secret deliberately has no
 * relationship to W3DS authentication credentials or browser-visible config.
 */
export function readMeshengerPlaybackGrantConfig(
  env: Record<string, string | undefined> = process.env,
): MeshengerPlaybackGrantConfig | undefined {
  const endpointValue = env.MESHENGER_PLAYBACK_GRANT_URL?.trim();
  const secret = env.VIDAK_PLAYBACK_BRIDGE_SECRET?.trim();
  if (!endpointValue || !secret || secret.length < 32) return undefined;

  const endpoint = parseSafePrivateMediaUpstreamUrl(endpointValue);
  if (
    !endpoint ||
    endpoint.pathname !== meshengerPlaybackGrantPath ||
    endpoint.search ||
    endpoint.hash
  ) {
    return undefined;
  }
  return { endpoint: endpoint.toString(), secret };
}

/** Exact canonical bytes shared with Meshenger's source grant implementation. */
export function meshengerPlaybackGrantSigningPayload(input: {
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  const bodyHash = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');
  return ['v1', 'POST', meshengerPlaybackGrantPath, input.timestamp, input.nonce, bodyHash].join(
    '\n',
  );
}

export function signMeshengerPlaybackGrantRequest(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return `v1=${createHmac('sha256', input.secret)
    .update(
      meshengerPlaybackGrantSigningPayload({
        timestamp: input.timestamp,
        nonce: input.nonce,
        rawBody: input.rawBody,
      }),
      'utf8',
    )
    .digest('hex')}`;
}

/**
 * Proves that a configured source bridge is actually deployed and accepts the
 * configured bridge secret without sending a viewer, recording, or File
 * reference. The source endpoint verifies the signature first, then rejects
 * the intentionally empty object as a bad request (HTTP 400). That is the
 * only successful probe response: a 404/401 must not silently leave Vidak on
 * the slow legacy path after a deployment mistake.
 */
export async function probeMeshengerPlaybackGrant(input: {
  config: MeshengerPlaybackGrantConfig;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const now = input.now?.() ?? Date.now();
  const timestamp = String(now);
  const nonce = randomBytes(24).toString('base64url');
  const rawBody = '{}';
  const signature = signMeshengerPlaybackGrantRequest({
    secret: input.config.secret,
    timestamp,
    nonce,
    rawBody,
  });
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.config.endpoint, {
      method: 'POST',
      body: rawBody,
      headers: {
        'content-type': 'application/json',
        'x-vidak-playback-timestamp': timestamp,
        'x-vidak-playback-nonce': nonce,
        'x-vidak-playback-signature': signature,
      },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.timeout(meshengerPlaybackGrantRequestTimeoutMs),
    });
  } catch {
    throw new Error('Meshenger playback bridge health probe failed.');
  }
  try {
    // The source bridge authenticates first and then rejects `{}` as malformed
    // input. Do not accept a generic framework 400 without its no-store
    // contract: that can otherwise hide a proxy/error page at this route.
    const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
    if (response.status !== 400 || !cacheControl.includes('no-store')) {
      throw new Error('Meshenger playback bridge health probe failed.');
    }
  } finally {
    await discardResponseBody(response);
  }
}

/**
 * Requests one source-issued media grant. No source URL, error body, request
 * identifiers, or bridge credentials leave this module.
 */
export async function requestMeshengerPlaybackGrant(input: {
  config: MeshengerPlaybackGrantConfig | undefined;
  request: MeshengerPlaybackGrantRequest;
  signal?: AbortSignal;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Promise<MeshengerPlaybackGrantResult> {
  if (!input.config) return { kind: 'not_configured' };
  if (input.signal?.aborted) return { kind: 'cancelled' };

  const now = input.now?.() ?? Date.now();
  const timestamp = String(now);
  const nonce = randomBytes(24).toString('base64url');
  const rawBody = JSON.stringify({ version: 1, ...input.request });
  const signature = signMeshengerPlaybackGrantRequest({
    secret: input.config.secret,
    timestamp,
    nonce,
    rawBody,
  });
  const signal = input.signal
    ? AbortSignal.any([AbortSignal.timeout(meshengerPlaybackGrantRequestTimeoutMs), input.signal])
    : AbortSignal.timeout(meshengerPlaybackGrantRequestTimeoutMs);

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(input.config.endpoint, {
      method: 'POST',
      body: rawBody,
      headers: {
        'content-type': 'application/json',
        'x-vidak-playback-timestamp': timestamp,
        'x-vidak-playback-nonce': nonce,
        'x-vidak-playback-signature': signature,
      },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal,
    });
  } catch {
    return input.signal?.aborted ? { kind: 'cancelled' } : { kind: 'unavailable' };
  }

  if (response.status === 409) {
    await discardResponseBody(response);
    return { kind: 'not_eligible' };
  }
  if (response.status === 404) {
    await discardResponseBody(response);
    return { kind: 'not_found' };
  }
  if (!response.ok) {
    await discardResponseBody(response);
    return response.status >= 500 || response.status === 408 || response.status === 429
      ? { kind: 'unavailable' }
      : { kind: 'rejected' };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: 'rejected' };
  } finally {
    await discardResponseBody(response);
  }
  const parsed = record(payload);
  const mediaUrl = typeof parsed?.mediaUrl === 'string' ? parsed.mediaUrl : undefined;
  const expiresAtValue = typeof parsed?.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : NaN;
  const safeMediaUrl = mediaUrl
    ? parseSafePrivateMediaUpstreamUrl(mediaUrl)?.toString()
    : undefined;
  if (
    parsed?.version !== 1 ||
    parsed.status !== 'granted' ||
    !safeMediaUrl ||
    !Number.isFinite(expiresAtValue) ||
    expiresAtValue <= now ||
    expiresAtValue > now + meshengerPlaybackGrantMaxCacheMs
  ) {
    return { kind: 'rejected' };
  }
  return { kind: 'granted', mediaUrl: safeMediaUrl, expiresAt: expiresAtValue };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is private and its body has no useful caller-visible data.
  }
}
