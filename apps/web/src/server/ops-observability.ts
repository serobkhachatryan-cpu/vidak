/**
 * Request correlation and structured server-side operational error reporting.
 * Logs are JSON lines to stderr — no third-party telemetry vendors.
 */

import { randomUUID } from 'node:crypto';
import { assertNoSensitiveLeak, redactSensitiveText } from './ops-redaction';

export const CORRELATION_HEADER = 'x-request-id';
export const CORRELATION_HEADER_ALT = 'x-correlation-id';

export type OperationalFailureCategory =
  | 'support'
  | 'authentication'
  | 'media_storage'
  | 'migration_readiness'
  | 'w3ds_sync'
  | 'video_playback'
  | 'video_preview'
  | 'video_library';

export type RequestHeadersLike = {
  get(name: string): string | null;
};

export interface OperationalFailureReport {
  level: 'error';
  category: OperationalFailureCategory;
  correlationId: string;
  code?: string;
  message: string;
}

/**
 * A redacted, server-side event suitable for operational counters. Events
 * intentionally carry no request body, headers, credentials, or entity IDs.
 */
export interface OperationalEventReport {
  level: 'info';
  category: OperationalFailureCategory;
  correlationId: string;
  code: string;
}

/**
 * Fixed-schema playback timings used to diagnose the private media proxy.
 *
 * The schema deliberately has no free-form fields: it can never carry a
 * stream id, eName, signed URL, request header, or credential into logs.
 */
export interface VideoPlaybackTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'media_response_ready_timing' | 'media_first_byte_timing';
  timing: {
    sessionValidationMs: number;
    sourceResolutionMs: number;
    mediaUrlCacheHit?: boolean;
    sharedAccessVerificationMs?: number;
    eVaultResolutionMs?: number;
    directFileDereferenceMs?: number;
    platformTokenMs?: number;
    metadataReadMs?: number;
    upstreamResponseHeadersMs?: number;
    responseReadyMs: number;
    initialRangeCacheHit: boolean;
    upstreamAttempts: number;
    upstreamFirstByteMs?: number;
    requestFirstByteMs?: number;
  };
}

/**
 * Fixed-schema timings captured when the private playback route cannot resolve
 * its authorized media source. This intentionally records no error text or
 * source identity; the correlated opaque failure event carries the safe
 * aggregate error code separately.
 */
export interface VideoSourceResolutionFailureTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'media_source_resolution_failed_timing';
  timing: {
    sessionValidationMs: number;
    sourceResolutionMs: number;
    mediaUrlCacheHit: boolean;
    sharedAccessVerificationMs: number;
    eVaultResolutionMs: number;
    directFileDereferenceMs: number;
    platformTokenMs: number;
    metadataReadMs: number;
    requestFailedMs: number;
  };
}

/**
 * A viewer may start this authorization request before navigating to the
 * player. Keep its evidence separate from media-response timings so a proof
 * delay is never mistaken for upstream media-byte latency.
 *
 * Every field is a fixed enum, boolean, or rounded duration. It intentionally
 * has no stream id, viewer, URL, grant, Chat, File, or error text.
 */
export type VideoAuthorizationTimingMode = 'interactive' | 'warmup' | 'background';
export type VideoAuthorizationFailureKind =
  | 'authentication'
  | 'authorization'
  | 'stream'
  | 'source_unavailable'
  | 'internal';

export interface VideoAuthorizationTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'media_authorization_timing';
  timing: {
    mode: VideoAuthorizationTimingMode;
    succeeded: boolean;
    failureKind?: VideoAuthorizationFailureKind;
    accessBasis?: 'personal' | 'membership' | 'history' | 'reference';
    proofKind?: 'personal' | 'group' | 'direct_group' | 'reference';
    sharedProofDeadlineMs?: number;
    viewerChatGrantHint?: boolean;
    sessionValidationMs: number;
    authorizationResolutionMs: number;
    mediaUrlCacheHit: boolean;
    sharedAccessVerificationMs: number;
    eVaultResolutionMs: number;
    directFileDereferenceMs: number;
    platformTokenMs: number;
    metadataReadMs: number;
    requestCompletedMs: number;
  };
}

/**
 * The ticket request is the first phase of a continuous recording open. Its
 * timings intentionally contain no recording size, stream grant, or viewer
 * identity: the opaque correlation id is the only join key for later events.
 */
export interface RecordingTicketTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'recording_ticket_timing';
  timing: {
    sessionValidationMs: number;
    firstSegmentValidationMs: number;
    ticketIssuedMs: number;
    requestReadyMs: number;
    warmupLaunched: boolean;
  };
}

/** Fixed, non-sensitive source-resolution phases shared by recording events. */
interface RecordingSourceResolutionTiming {
  mediaUrlCacheHit: boolean;
  sharedAccessVerificationMs: number;
  eVaultResolutionMs: number;
  directFileDereferenceMs: number;
  platformTokenMs: number;
  metadataReadMs: number;
}

/**
 * The ticket route emits this event for segment zero only. It measures the
 * preflight authorization that completes before an opaque ticket is returned,
 * and never records its result URL, error text, grant, or source identity.
 */
export interface RecordingWarmupTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'recording_warmup_timing';
  timing: RecordingSourceResolutionTiming & {
    warmupCompletedMs: number;
    succeeded: boolean;
  };
}

/**
 * Timings at the loopback segment proxy, emitted only for segment zero. The
 * separate first-byte event distinguishes upstream headers from media bytes
 * arriving at ffmpeg without logging the loopback capability or source URL.
 */
export interface RecordingSegmentTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'recording_segment_response_ready_timing' | 'recording_segment_first_byte_timing';
  timing: RecordingSourceResolutionTiming & {
    sourceResolutionMs: number;
    upstreamResponseHeadersMs: number;
    segmentResponseReadyMs: number;
    upstreamAttempts: number;
    upstreamFirstByteMs?: number;
    segmentRequestFirstByteMs?: number;
  };
}

/**
 * A source-resolution failure has no upstream response to time. Keep it
 * separate so it cannot be mistaken for a successful recording start.
 */
export interface RecordingSegmentSourceResolutionFailureTimingReport
  extends OperationalEventReport {
  category: 'video_playback';
  code: 'recording_segment_source_resolution_failed_timing';
  timing: RecordingSourceResolutionTiming & {
    /** Sanitized classification; never an upstream message, URL, or grant. */
    failureKind: 'authorization_denied' | 'authorization_retry' | 'source';
    sourceResolutionMs: number;
    segmentRequestFailedMs: number;
  };
}

/**
 * Timings at the browser-visible ffmpeg concat stream. These are correlated
 * with the ticket and loopback events through an opaque, server-generated id.
 */
export interface RecordingFfmpegTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'recording_ffmpeg_response_ready_timing' | 'recording_ffmpeg_first_byte_timing';
  timing: {
    sessionValidationMs: number;
    ticketClaimMs: number;
    ffmpegStartupMs: number;
    responseReadyMs: number;
    requestFirstByteMs?: number;
  };
}

/**
 * The concat route waits for one real ffmpeg byte before it commits HTTP 200.
 * Keep pre-response failures separate from successful timing samples so a
 * stalled/missing process cannot make playback look merely slow. This schema
 * is deliberately finite and contains no stderr, source URL, ticket, or
 * viewer data.
 */
export type RecordingFfmpegStartupFailureKind =
  | 'spawn_error'
  | 'exited_before_output'
  | 'startup_timeout';

export interface RecordingFfmpegStartupFailureTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'recording_ffmpeg_startup_failed_timing';
  timing: {
    failureKind: RecordingFfmpegStartupFailureKind;
    sessionValidationMs: number;
    ticketClaimMs: number;
    ffmpegStartupMs: number;
    requestFailedMs: number;
  };
}

/**
 * A post-response outcome for the continuous ffmpeg joiner. Unlike startup
 * timing, this makes an unexpected EOF visible without ever collecting media
 * bytes, source URLs, tickets, viewers, or ffmpeg stderr.
 */
export interface RecordingFfmpegCompletionTimingReport extends OperationalEventReport {
  category: 'video_playback';
  code: 'recording_ffmpeg_completion_timing';
  timing: {
    outcome: 'completed' | 'cancelled' | 'failed';
    bytesProduced: number;
    exitCode?: number;
    requestCompletedMs: number;
  };
}

export type OperationalLogSink = (line: string) => void;

const defaultLogSink: OperationalLogSink = (line) => {
  // Keep Vitest output quiet unless a test installs an explicit sink.
  if (process.env.NODE_ENV === 'test') return;
  console.error(line);
};

let logSink: OperationalLogSink = defaultLogSink;

/** Test helper to capture structured operational logs. */
export function setOperationalLogSinkForTests(sink: OperationalLogSink | undefined): void {
  logSink = sink ?? defaultLogSink;
}

export function createCorrelationId(): string {
  return randomUUID();
}

/**
 * Resolves a caller-supplied correlation id or creates one.
 * Accepts `X-Request-Id` or `X-Correlation-Id`.
 */
export function resolveCorrelationId(headers: RequestHeadersLike): string {
  const fromRequest =
    normalizeCorrelationId(headers.get(CORRELATION_HEADER)) ??
    normalizeCorrelationId(headers.get(CORRELATION_HEADER_ALT));
  return fromRequest ?? createCorrelationId();
}

export function normalizeCorrelationId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // Keep ids opaque and log-safe; reject control characters / huge values.
  if (trimmed.length > 128 || /[^\x20-\x7E]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Emits a redacted structured error for operational categories.
 * Never logs cookies, bearer tokens, credentials, or sensitive config values.
 */
export function reportOperationalFailure(input: {
  category: OperationalFailureCategory;
  error: unknown;
  correlationId?: string;
  code?: string;
}): OperationalFailureReport {
  const report: OperationalFailureReport = {
    level: 'error',
    category: input.category,
    correlationId: input.correlationId ?? createCorrelationId(),
    message: redactSensitiveText(input.error, `${input.category} failure`),
    ...(input.code ? { code: input.code } : {}),
  };

  const line = JSON.stringify(report);
  assertNoSensitiveLeak(line);
  logSink(line);
  return report;
}

/**
 * Emits a structured, non-sensitive operational event. Deployment log
 * aggregation can count `category` and `code` without retaining W3DS packet
 * contents or credentials.
 */
export function reportOperationalEvent(input: {
  category: OperationalFailureCategory;
  correlationId?: string;
  code: string;
}): OperationalEventReport {
  const report: OperationalEventReport = {
    level: 'info',
    category: input.category,
    correlationId: input.correlationId ?? createCorrelationId(),
    code: input.code,
  };

  const line = JSON.stringify(report);
  assertNoSensitiveLeak(line);
  logSink(line);
  return report;
}

/**
 * Emits only fixed, rounded timing fields for an authorized video response.
 * Do not add source identifiers or arbitrary context here: correlation IDs
 * are the sole join key for the two events emitted by one media request.
 */
export function reportVideoPlaybackTiming(input: {
  correlationId: string;
  phase: 'response_ready' | 'first_byte';
  sessionValidationMs: number;
  sourceResolutionMs: number;
  mediaUrlCacheHit?: boolean;
  sharedAccessVerificationMs?: number;
  eVaultResolutionMs?: number;
  directFileDereferenceMs?: number;
  platformTokenMs?: number;
  metadataReadMs?: number;
  upstreamResponseHeadersMs?: number;
  responseReadyMs: number;
  initialRangeCacheHit: boolean;
  upstreamAttempts: number;
  upstreamFirstByteMs?: number;
  requestFirstByteMs?: number;
}): VideoPlaybackTimingReport {
  const report: VideoPlaybackTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code:
      input.phase === 'response_ready' ? 'media_response_ready_timing' : 'media_first_byte_timing',
    timing: {
      sessionValidationMs: normalizeTimingMs(input.sessionValidationMs),
      sourceResolutionMs: normalizeTimingMs(input.sourceResolutionMs),
      ...(input.mediaUrlCacheHit === undefined ? {} : { mediaUrlCacheHit: input.mediaUrlCacheHit }),
      ...(input.sharedAccessVerificationMs === undefined
        ? {}
        : { sharedAccessVerificationMs: normalizeTimingMs(input.sharedAccessVerificationMs) }),
      ...(input.eVaultResolutionMs === undefined
        ? {}
        : { eVaultResolutionMs: normalizeTimingMs(input.eVaultResolutionMs) }),
      ...(input.directFileDereferenceMs === undefined
        ? {}
        : { directFileDereferenceMs: normalizeTimingMs(input.directFileDereferenceMs) }),
      ...(input.platformTokenMs === undefined
        ? {}
        : { platformTokenMs: normalizeTimingMs(input.platformTokenMs) }),
      ...(input.metadataReadMs === undefined
        ? {}
        : { metadataReadMs: normalizeTimingMs(input.metadataReadMs) }),
      ...(input.upstreamResponseHeadersMs === undefined
        ? {}
        : { upstreamResponseHeadersMs: normalizeTimingMs(input.upstreamResponseHeadersMs) }),
      responseReadyMs: normalizeTimingMs(input.responseReadyMs),
      initialRangeCacheHit: input.initialRangeCacheHit,
      upstreamAttempts: normalizeTimingCount(input.upstreamAttempts),
      ...(input.upstreamFirstByteMs === undefined
        ? {}
        : { upstreamFirstByteMs: normalizeTimingMs(input.upstreamFirstByteMs) }),
      ...(input.requestFirstByteMs === undefined
        ? {}
        : { requestFirstByteMs: normalizeTimingMs(input.requestFirstByteMs) }),
    },
  };

  const line = JSON.stringify(report);
  assertNoSensitiveLeak(line);
  logSink(line);
  return report;
}

/**
 * Emits only the fixed timing phases available at a source-resolution
 * failure. Keep this separate from a successful response-ready event: no
 * upstream response exists yet, and treating it as one would distort playback
 * latency aggregates.
 */
export function reportVideoSourceResolutionFailureTiming(input: {
  correlationId: string;
  sessionValidationMs: number;
  sourceResolutionMs: number;
  mediaUrlCacheHit: boolean;
  sharedAccessVerificationMs: number;
  eVaultResolutionMs: number;
  directFileDereferenceMs: number;
  platformTokenMs: number;
  metadataReadMs: number;
  requestFailedMs: number;
}): VideoSourceResolutionFailureTimingReport {
  const report: VideoSourceResolutionFailureTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code: 'media_source_resolution_failed_timing',
    timing: {
      sessionValidationMs: normalizeTimingMs(input.sessionValidationMs),
      sourceResolutionMs: normalizeTimingMs(input.sourceResolutionMs),
      mediaUrlCacheHit: input.mediaUrlCacheHit,
      sharedAccessVerificationMs: normalizeTimingMs(input.sharedAccessVerificationMs),
      eVaultResolutionMs: normalizeTimingMs(input.eVaultResolutionMs),
      directFileDereferenceMs: normalizeTimingMs(input.directFileDereferenceMs),
      platformTokenMs: normalizeTimingMs(input.platformTokenMs),
      metadataReadMs: normalizeTimingMs(input.metadataReadMs),
      requestFailedMs: normalizeTimingMs(input.requestFailedMs),
    },
  };

  const line = JSON.stringify(report);
  assertNoSensitiveLeak(line);
  logSink(line);
  return report;
}

/**
 * Emits the fixed authorization phases that precede a private player
 * navigation. A failed request has only a coarse error category, never an
 * upstream error or access identity.
 */
export function reportVideoAuthorizationTiming(input: {
  correlationId: string;
  mode: VideoAuthorizationTimingMode;
  succeeded: boolean;
  failureKind?: VideoAuthorizationFailureKind;
  accessBasis?: 'personal' | 'membership' | 'history' | 'reference';
  proofKind?: 'personal' | 'group' | 'direct_group' | 'reference';
  sharedProofDeadlineMs?: number;
  viewerChatGrantHint?: boolean;
  sessionValidationMs: number;
  authorizationResolutionMs: number;
  mediaUrlCacheHit: boolean;
  sharedAccessVerificationMs: number;
  eVaultResolutionMs: number;
  directFileDereferenceMs: number;
  platformTokenMs: number;
  metadataReadMs: number;
  requestCompletedMs: number;
}): VideoAuthorizationTimingReport {
  const report: VideoAuthorizationTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code: 'media_authorization_timing',
    timing: {
      mode: input.mode,
      succeeded: input.succeeded,
      ...(input.failureKind === undefined ? {} : { failureKind: input.failureKind }),
      ...(input.accessBasis === undefined ? {} : { accessBasis: input.accessBasis }),
      ...(input.proofKind === undefined ? {} : { proofKind: input.proofKind }),
      ...(input.sharedProofDeadlineMs === undefined
        ? {}
        : { sharedProofDeadlineMs: normalizeTimingMs(input.sharedProofDeadlineMs) }),
      ...(input.viewerChatGrantHint === undefined
        ? {}
        : { viewerChatGrantHint: input.viewerChatGrantHint }),
      sessionValidationMs: normalizeTimingMs(input.sessionValidationMs),
      authorizationResolutionMs: normalizeTimingMs(input.authorizationResolutionMs),
      mediaUrlCacheHit: input.mediaUrlCacheHit,
      sharedAccessVerificationMs: normalizeTimingMs(input.sharedAccessVerificationMs),
      eVaultResolutionMs: normalizeTimingMs(input.eVaultResolutionMs),
      directFileDereferenceMs: normalizeTimingMs(input.directFileDereferenceMs),
      platformTokenMs: normalizeTimingMs(input.platformTokenMs),
      metadataReadMs: normalizeTimingMs(input.metadataReadMs),
      requestCompletedMs: normalizeTimingMs(input.requestCompletedMs),
    },
  };
  emitOperationalTiming(report);
  return report;
}

/** Emits the fixed phase timings for an opaque continuous-recording ticket. */
export function reportRecordingTicketTiming(input: {
  correlationId: string;
  sessionValidationMs: number;
  firstSegmentValidationMs: number;
  ticketIssuedMs: number;
  requestReadyMs: number;
  warmupLaunched: boolean;
}): RecordingTicketTimingReport {
  const report: RecordingTicketTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code: 'recording_ticket_timing',
    timing: {
      sessionValidationMs: normalizeTimingMs(input.sessionValidationMs),
      firstSegmentValidationMs: normalizeTimingMs(input.firstSegmentValidationMs),
      ticketIssuedMs: normalizeTimingMs(input.ticketIssuedMs),
      requestReadyMs: normalizeTimingMs(input.requestReadyMs),
      warmupLaunched: input.warmupLaunched,
    },
  };
  emitOperationalTiming(report);
  return report;
}

/** Emits source-resolution timing for the source-zero ticket preflight. */
export function reportRecordingWarmupTiming(
  input: {
    correlationId: string;
    warmupCompletedMs: number;
    succeeded: boolean;
  } & RecordingSourceResolutionTiming,
): RecordingWarmupTimingReport {
  const report: RecordingWarmupTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code: 'recording_warmup_timing',
    timing: {
      ...normalizeRecordingSourceResolutionTiming(input),
      warmupCompletedMs: normalizeTimingMs(input.warmupCompletedMs),
      succeeded: input.succeeded,
    },
  };
  emitOperationalTiming(report);
  return report;
}

/** Emits loopback segment timing without a source, ticket, or viewer field. */
export function reportRecordingSegmentTiming(
  input: {
    correlationId: string;
    phase: 'response_ready' | 'first_byte';
    sourceResolutionMs: number;
    upstreamResponseHeadersMs: number;
    segmentResponseReadyMs: number;
    upstreamAttempts: number;
    upstreamFirstByteMs?: number;
    segmentRequestFirstByteMs?: number;
  } & RecordingSourceResolutionTiming,
): RecordingSegmentTimingReport {
  const report: RecordingSegmentTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code:
      input.phase === 'response_ready'
        ? 'recording_segment_response_ready_timing'
        : 'recording_segment_first_byte_timing',
    timing: {
      ...normalizeRecordingSourceResolutionTiming(input),
      sourceResolutionMs: normalizeTimingMs(input.sourceResolutionMs),
      upstreamResponseHeadersMs: normalizeTimingMs(input.upstreamResponseHeadersMs),
      segmentResponseReadyMs: normalizeTimingMs(input.segmentResponseReadyMs),
      upstreamAttempts: normalizeTimingCount(input.upstreamAttempts),
      ...(input.upstreamFirstByteMs === undefined
        ? {}
        : { upstreamFirstByteMs: normalizeTimingMs(input.upstreamFirstByteMs) }),
      ...(input.segmentRequestFirstByteMs === undefined
        ? {}
        : { segmentRequestFirstByteMs: normalizeTimingMs(input.segmentRequestFirstByteMs) }),
    },
  };
  emitOperationalTiming(report);
  return report;
}

/** Emits the available timing phases when segment-zero cannot resolve a source. */
export function reportRecordingSegmentSourceResolutionFailureTiming(
  input: {
    correlationId: string;
    failureKind: 'authorization_denied' | 'authorization_retry' | 'source';
    sourceResolutionMs: number;
    segmentRequestFailedMs: number;
  } & RecordingSourceResolutionTiming,
): RecordingSegmentSourceResolutionFailureTimingReport {
  const report: RecordingSegmentSourceResolutionFailureTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code: 'recording_segment_source_resolution_failed_timing',
    timing: {
      ...normalizeRecordingSourceResolutionTiming(input),
      failureKind: input.failureKind,
      sourceResolutionMs: normalizeTimingMs(input.sourceResolutionMs),
      segmentRequestFailedMs: normalizeTimingMs(input.segmentRequestFailedMs),
    },
  };
  emitOperationalTiming(report);
  return report;
}

/** Emits the response-ready and first-byte timings for the ffmpeg joiner. */
export function reportRecordingFfmpegTiming(input: {
  correlationId: string;
  phase: 'response_ready' | 'first_byte';
  sessionValidationMs: number;
  ticketClaimMs: number;
  ffmpegStartupMs: number;
  responseReadyMs: number;
  requestFirstByteMs?: number;
}): RecordingFfmpegTimingReport {
  const report: RecordingFfmpegTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code:
      input.phase === 'response_ready'
        ? 'recording_ffmpeg_response_ready_timing'
        : 'recording_ffmpeg_first_byte_timing',
    timing: {
      sessionValidationMs: normalizeTimingMs(input.sessionValidationMs),
      ticketClaimMs: normalizeTimingMs(input.ticketClaimMs),
      ffmpegStartupMs: normalizeTimingMs(input.ffmpegStartupMs),
      responseReadyMs: normalizeTimingMs(input.responseReadyMs),
      ...(input.requestFirstByteMs === undefined
        ? {}
        : { requestFirstByteMs: normalizeTimingMs(input.requestFirstByteMs) }),
    },
  };
  emitOperationalTiming(report);
  return report;
}

/** Emits only stable, non-sensitive timing for a pre-response ffmpeg failure. */
export function reportRecordingFfmpegStartupFailureTiming(input: {
  correlationId: string;
  failureKind: RecordingFfmpegStartupFailureKind;
  sessionValidationMs: number;
  ticketClaimMs: number;
  ffmpegStartupMs: number;
  requestFailedMs: number;
}): RecordingFfmpegStartupFailureTimingReport {
  const report: RecordingFfmpegStartupFailureTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code: 'recording_ffmpeg_startup_failed_timing',
    timing: {
      failureKind: input.failureKind,
      sessionValidationMs: normalizeTimingMs(input.sessionValidationMs),
      ticketClaimMs: normalizeTimingMs(input.ticketClaimMs),
      ffmpegStartupMs: normalizeTimingMs(input.ffmpegStartupMs),
      requestFailedMs: normalizeTimingMs(input.requestFailedMs),
    },
  };
  emitOperationalTiming(report);
  return report;
}

/** Emits a fixed-schema result after an already-started ffmpeg stream closes. */
export function reportRecordingFfmpegCompletionTiming(input: {
  correlationId: string;
  outcome: 'completed' | 'cancelled' | 'failed';
  bytesProduced: number;
  exitCode?: number;
  requestCompletedMs: number;
}): RecordingFfmpegCompletionTimingReport {
  const report: RecordingFfmpegCompletionTimingReport = {
    level: 'info',
    category: 'video_playback',
    correlationId: input.correlationId,
    code: 'recording_ffmpeg_completion_timing',
    timing: {
      outcome: input.outcome,
      bytesProduced: normalizeByteCount(input.bytesProduced),
      ...(input.exitCode === undefined ? {} : { exitCode: normalizeExitCode(input.exitCode) }),
      requestCompletedMs: normalizeTimingMs(input.requestCompletedMs),
    },
  };
  emitOperationalTiming(report);
  return report;
}

function normalizeRecordingSourceResolutionTiming(
  input: RecordingSourceResolutionTiming,
): RecordingSourceResolutionTiming {
  return {
    mediaUrlCacheHit: input.mediaUrlCacheHit,
    sharedAccessVerificationMs: normalizeTimingMs(input.sharedAccessVerificationMs),
    eVaultResolutionMs: normalizeTimingMs(input.eVaultResolutionMs),
    directFileDereferenceMs: normalizeTimingMs(input.directFileDereferenceMs),
    platformTokenMs: normalizeTimingMs(input.platformTokenMs),
    metadataReadMs: normalizeTimingMs(input.metadataReadMs),
  };
}

function emitOperationalTiming(report: OperationalEventReport): void {
  const line = JSON.stringify(report);
  assertNoSensitiveLeak(line);
  logSink(line);
}

function normalizeTimingMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function normalizeTimingCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeByteCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function normalizeExitCode(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.floor(value)));
}
