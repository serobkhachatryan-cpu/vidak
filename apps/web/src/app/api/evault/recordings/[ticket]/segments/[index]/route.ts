import { type NextRequest, NextResponse } from 'next/server';
import {
  createEVaultVideoLibrary,
  EVaultVideoLibraryError,
  type MediaResolutionTiming,
} from '../../../../../../../server/evault-video-library';
import {
  reportRecordingSegmentSourceResolutionFailureTiming,
  reportRecordingSegmentTiming,
} from '../../../../../../../server/ops-observability';
import {
  isRefreshablePrivateMediaFailure,
  openPrivateMediaUpstream,
} from '../../../../../../../server/private-media-upstream';
import {
  RecordingConcatTicketError,
  readRecordingConcatSegment,
  replaceRecordingConcatInitialSegment,
  replaceRecordingConcatSegment,
} from '../../../../../../../server/recording-concat-ticket';
import {
  mintSharedVideoAuthorizationReceipt,
  SharedVideoAuthorizationReceiptConfigurationError,
  verifySharedVideoAuthorizationReceipt,
} from '../../../../../../../server/shared-video-authorization-receipt';
import { recordConfirmedSharedPlaybackDenial } from '../../../../../../../server/video-space/shared-playback-card-quarantine';

export const runtime = 'nodejs';

// A call recorder commonly emits roughly 45-second source files. Resolve only
// the immediate next source during that window so ffmpeg can cross the
// boundary from this same loopback-owning replica without another cold shared
// authorization. This is deliberately shorter than a segment: a stuck source
// must not accumulate speculative eVault work after the current request ends.
const nextRecordingSegmentWarmupTimeoutMs = 8_000;

/**
 * Loopback-only source endpoint for ffmpeg. The browser never receives the
 * segment key or a source URL. It resolves one segment only when the concat
 * demuxer advances to it, so a long call can begin from its first file.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ ticket: string; index: string }> },
) {
  const requestStartedAt = performance.now();
  let correlationId: string | undefined;
  let shouldReportInitialSegmentTiming = false;
  let sourceResolutionMs = 0;
  let mediaResolutionTiming: MediaResolutionTiming | undefined;
  let upstreamResponseHeadersMs = 0;
  let upstreamAttempts = 0;
  let sourceResolutionFailed = false;
  let sourceResolutionFailureKind: 'authorization_denied' | 'authorization_retry' | 'source' =
    'source';
  let finalUpstreamStartedAt = 0;
  const recordMediaResolutionTiming = (timing: MediaResolutionTiming): void => {
    mediaResolutionTiming = mergeMediaResolutionTiming(mediaResolutionTiming, timing);
  };
  const sourceTiming = (): MediaResolutionTiming =>
    mediaResolutionTiming ?? emptyMediaResolutionTiming();
  const reportResponseReadyTiming = (): number => {
    const segmentResponseReadyMs = elapsedMs(requestStartedAt);
    if (!shouldReportInitialSegmentTiming || !correlationId) return segmentResponseReadyMs;
    safelyReportSegmentTiming({
      correlationId,
      phase: 'response_ready',
      sourceResolutionMs,
      ...sourceTiming(),
      upstreamResponseHeadersMs,
      segmentResponseReadyMs,
      upstreamAttempts,
    });
    return segmentResponseReadyMs;
  };
  const reportSourceResolutionFailureTiming = (): void => {
    if (!shouldReportInitialSegmentTiming || !correlationId || !sourceResolutionFailed) return;
    safelyReportSegmentSourceResolutionFailureTiming({
      correlationId,
      failureKind: sourceResolutionFailureKind,
      sourceResolutionMs,
      ...sourceTiming(),
      segmentRequestFailedMs: elapsedMs(requestStartedAt),
    });
  };
  try {
    const { ticket, index } = await context.params;
    const segmentKey = request.nextUrl.searchParams.get('key');
    const segment = await readRecordingConcatSegment(ticket, segmentKey, index);
    correlationId = segment.correlationId;
    // Later segment reads can occur hours into a recording. Report only the
    // first segment's cold-start path so logs are both useful and bounded.
    shouldReportInitialSegmentTiming = index === '0';
    const hasRecentSharedAuthorizationReceipt = hasVerifiedSegmentAuthorizationReceipt(
      segment.initialAuthorizationReceipt,
      segment.viewer.eName,
      segment.streamId,
    );
    const library = createEVaultVideoLibrary();
    const resolveCurrentSegment = async (
      candidateStreamId: string,
    ): Promise<{ streamId: string; mediaUrl: string }> => {
      const sourceResolutionStartedAt = performance.now();
      try {
        return await resolveSegmentMedia(
          library,
          segment.viewer,
          ticket,
          segmentKey,
          index,
          candidateStreamId,
          shouldReportInitialSegmentTiming ? recordMediaResolutionTiming : undefined,
          // A receipt is bound to the original source-zero stream. A renewed
          // stream is a different sealed grant and must perform its own proof.
          candidateStreamId === segment.streamId && hasRecentSharedAuthorizationReceipt,
        );
      } catch (error) {
        sourceResolutionFailed = true;
        sourceResolutionFailureKind = recordingSourceResolutionFailureKind(error);
        throw error;
      } finally {
        sourceResolutionMs += elapsedMs(sourceResolutionStartedAt);
      }
    };
    let { streamId: resolvedStreamId, mediaUrl } = await resolveCurrentSegment(segment.streamId);

    const range = request.headers.get('range');
    const openUpstream = async () => {
      const result = await openPrivateMediaUpstream({
        mediaUrl,
        range,
        signal: request.signal,
      });
      upstreamAttempts += result.upstreamAttempts;
      upstreamResponseHeadersMs += result.responseHeadersMs;
      if (result.kind === 'success') finalUpstreamStartedAt = result.finalUpstreamStartedAt;
      return result;
    };
    let upstreamResult = await openUpstream();
    if (
      upstreamResult.kind === 'failure' &&
      isRefreshablePrivateMediaFailure(upstreamResult.failure)
    ) {
      try {
        await library.invalidateMediaUrl(segment.viewer, resolvedStreamId);
      } catch (error) {
        if (!(error instanceof EVaultVideoLibraryError) || error.code !== 'stream_expired') {
          throw error;
        }
      }
      ({ streamId: resolvedStreamId, mediaUrl } = await resolveCurrentSegment(resolvedStreamId));
      upstreamResult = await openUpstream();
    }
    if (upstreamResult.kind === 'failure') {
      throw new EVaultVideoLibraryError(
        'The recording segment is unavailable.',
        'remote_rejected',
        502,
      );
    }
    const upstream = upstreamResult.response;

    const headers = new Headers({
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }
    const segmentResponseReadyMs = reportResponseReadyTiming();
    const initialSegmentCorrelationId = correlationId;
    const observedUpstreamBody =
      shouldReportInitialSegmentTiming && initialSegmentCorrelationId
        ? observeFirstUpstreamByte(upstream.body, () => {
            safelyReportSegmentTiming({
              correlationId: initialSegmentCorrelationId,
              phase: 'first_byte',
              sourceResolutionMs,
              ...sourceTiming(),
              upstreamResponseHeadersMs,
              segmentResponseReadyMs,
              upstreamAttempts,
              upstreamFirstByteMs: elapsedMs(finalUpstreamStartedAt),
              segmentRequestFirstByteMs: elapsedMs(requestStartedAt),
            });
          })
        : upstream.body;
    // This detached hint starts only after the current source has supplied a
    // first media byte. It reads no next-segment bytes, does not reuse the
    // source-zero receipt, and can never delay or alter this response. The
    // normal next route still validates/renews/retries independently.
    startNextRecordingSegmentWarmup({
      library,
      requestSignal: request.signal,
      ticket,
      segmentKey,
      currentIndex: index,
    });
    return new NextResponse(observedUpstreamBody, { status: upstream.status, headers });
  } catch (error) {
    reportSourceResolutionFailureTiming();
    // A later segment can be the first request to discover that the entire
    // continuous shared recording was revoked. Record only a typed terminal
    // live denial; warmup and upstream failures never reach this marker.
    recordConfirmedSharedPlaybackDenial(error);
    return errorResponse(error);
  }
}

/**
 * Preauthorize exactly index + 1 on the local ffmpeg-owning process. The
 * media URL remains in the library's server-only cache; the result is neither
 * stored in the ticket nor exposed to the browser. Any failure is purposely a
 * no-op because the current stream is already healthy and the next segment
 * has its own authoritative recovery path.
 */
function startNextRecordingSegmentWarmup(input: {
  library: ReturnType<typeof createEVaultVideoLibrary>;
  requestSignal: AbortSignal;
  ticket: string;
  segmentKey: string | null;
  currentIndex: string;
}): void {
  const nextIndex = nextRecordingSegmentIndex(input.currentIndex);
  if (nextIndex === undefined || input.requestSignal.aborted) return;

  const controller = new AbortController();
  const abortForRequest = () => controller.abort();
  input.requestSignal.addEventListener('abort', abortForRequest, { once: true });
  const timeout = setTimeout(() => controller.abort(), nextRecordingSegmentWarmupTimeoutMs);
  timeout.unref?.();
  void (async () => {
    try {
      const next = await readRecordingConcatSegment(input.ticket, input.segmentKey, nextIndex);
      await input.library.authorizePlayableStream(next.viewer, next.streamId, {
        priority: 'warmup',
        signal: controller.signal,
      });
    } catch {
      // A last segment, expired ticket, revoked source, or transient eVault
      // failure must never poison the already-started current stream.
    } finally {
      clearTimeout(timeout);
      input.requestSignal.removeEventListener('abort', abortForRequest);
    }
  })();
}

function nextRecordingSegmentIndex(currentIndex: string): string | undefined {
  if (!/^\d+$/.test(currentIndex)) return undefined;
  const current = Number(currentIndex);
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return String(current + 1);
}

async function resolveSegmentMedia(
  library: ReturnType<typeof createEVaultVideoLibrary>,
  viewer: Parameters<ReturnType<typeof createEVaultVideoLibrary>['resolveMediaUrl']>[0],
  ticket: string,
  segmentKey: string | null,
  index: string,
  streamId: string,
  onTiming: ((timing: MediaResolutionTiming) => void) | undefined,
  hasRecentSharedAuthorizationReceipt: boolean,
): Promise<{ streamId: string; mediaUrl: string }> {
  const resolveMediaUrl = (
    candidateStreamId: string,
    canReuseAuthorizationReceipt = hasRecentSharedAuthorizationReceipt,
  ): Promise<string> => {
    const options = {
      ...(onTiming ? { onTiming } : {}),
      ...(canReuseAuthorizationReceipt ? { hasRecentSharedAuthorizationReceipt: true } : {}),
    };
    return Object.keys(options).length > 0
      ? library.resolveMediaUrl(viewer, candidateStreamId, options)
      : library.resolveMediaUrl(viewer, candidateStreamId);
  };
  try {
    return { streamId, mediaUrl: await resolveMediaUrl(streamId) };
  } catch (error) {
    if (!(error instanceof EVaultVideoLibraryError) || error.code !== 'stream_expired') throw error;
    const renewed = await library.renewPlayableStream(viewer, streamId);
    // A renewal creates a new sealed stream, so the old source-zero receipt
    // cannot be reused. Complete the canonical eVault authorization first;
    // only then mint and persist a receipt bound to the replacement stream so
    // a retry or a different replica does not immediately repeat the shared
    // access proof. If receipt configuration is unavailable, the ordinary
    // replacement path clears the old hint and remains safe.
    const mediaUrl = await resolveMediaUrl(renewed, false);
    const renewedInitialReceipt =
      index === '0' ? mintRenewedInitialAuthorizationReceipt(viewer.eName, renewed) : undefined;
    if (renewedInitialReceipt) {
      await replaceRecordingConcatInitialSegment(
        ticket,
        segmentKey,
        renewed,
        renewedInitialReceipt,
      );
    } else {
      await replaceRecordingConcatSegment(ticket, segmentKey, index, renewed);
    }
    return { streamId: renewed, mediaUrl };
  }
}

/**
 * A receipt is only a short-lived cross-replica optimization. Configuration
 * absence must never turn an already-authorized renewal into a player error;
 * the ticket replacement then clears the stale receipt instead.
 */
function mintRenewedInitialAuthorizationReceipt(
  viewerEName: string,
  streamId: string,
): string | undefined {
  try {
    const receipt = mintSharedVideoAuthorizationReceipt({ viewerEName, streamId });
    return verifySharedVideoAuthorizationReceipt({ receipt, viewerEName, streamId })
      ? receipt
      : undefined;
  } catch (error) {
    if (error instanceof SharedVideoAuthorizationReceiptConfigurationError) return undefined;
    throw error;
  }
}

function hasVerifiedSegmentAuthorizationReceipt(
  receipt: string | undefined,
  viewerEName: string,
  streamId: string,
): boolean {
  if (!receipt) return false;
  try {
    return verifySharedVideoAuthorizationReceipt({ receipt, viewerEName, streamId });
  } catch (error) {
    // The receipt is an optimization. A local development/test configuration
    // without the production signing key still uses the normal source proof.
    if (error instanceof SharedVideoAuthorizationReceiptConfigurationError) return false;
    throw error;
  }
}

/**
 * Preserve the meaningful authorization distinction without ever emitting a
 * source message, URL, stream, ticket, or viewer identity into timing logs.
 */
function recordingSourceResolutionFailureKind(
  error: unknown,
): 'authorization_denied' | 'authorization_retry' | 'source' {
  if (!(error instanceof EVaultVideoLibraryError)) return 'source';
  if (error.code === 'authorization_denied') return 'authorization_denied';
  if (error.code === 'remote_unavailable' || error.code === 'rate_limited') {
    return 'authorization_retry';
  }
  return 'source';
}

/**
 * Fetch resolving only proves that upstream headers arrived. This wrapper
 * records when a non-empty source chunk crosses the loopback proxy toward
 * ffmpeg; it does not inspect, retain, or alter the media bytes.
 */
function observeFirstUpstreamByte(
  body: ReadableStream<Uint8Array> | null,
  onFirstByte: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  let firstByteObserved = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!firstByteObserved && chunk.byteLength > 0) {
          firstByteObserved = true;
          try {
            onFirstByte();
          } catch {
            // Logging must never interrupt private recording bytes.
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function safelyReportSegmentTiming(
  input: Parameters<typeof reportRecordingSegmentTiming>[0],
): void {
  try {
    reportRecordingSegmentTiming(input);
  } catch {
    // Operational timing is diagnostic-only.
  }
}

function safelyReportSegmentSourceResolutionFailureTiming(
  input: Parameters<typeof reportRecordingSegmentSourceResolutionFailureTiming>[0],
): void {
  try {
    reportRecordingSegmentSourceResolutionFailureTiming(input);
  } catch {
    // Operational timing is diagnostic-only.
  }
}

function emptyMediaResolutionTiming(): MediaResolutionTiming {
  return {
    mediaUrlCacheHit: false,
    sharedAccessVerificationMs: 0,
    eVaultResolutionMs: 0,
    directFileDereferenceMs: 0,
    platformTokenMs: 0,
    metadataReadMs: 0,
  };
}

function mergeMediaResolutionTiming(
  current: MediaResolutionTiming | undefined,
  next: MediaResolutionTiming,
): MediaResolutionTiming {
  if (!current) return next;
  return {
    mediaUrlCacheHit: current.mediaUrlCacheHit && next.mediaUrlCacheHit,
    sharedAccessVerificationMs:
      current.sharedAccessVerificationMs + next.sharedAccessVerificationMs,
    eVaultResolutionMs: current.eVaultResolutionMs + next.eVaultResolutionMs,
    directFileDereferenceMs: current.directFileDereferenceMs + next.directFileDereferenceMs,
    platformTokenMs: current.platformTokenMs + next.platformTokenMs,
    metadataReadMs: current.metadataReadMs + next.metadataReadMs,
  };
}

function elapsedMs(startedAt: number): number {
  return performance.now() - startedAt;
}

function errorResponse(error: unknown): NextResponse {
  const known =
    error instanceof EVaultVideoLibraryError || error instanceof RecordingConcatTicketError;
  const status = known ? error.status : 500;
  const code = known ? error.code : 'recording_segment_unavailable';
  const message = known ? error.message : 'The recording segment is unavailable.';
  const response = NextResponse.json({ error: { code, message } }, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
