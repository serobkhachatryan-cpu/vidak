export type PlaybackFailure = Readonly<{ title: string; description: string }>;

export type SingleVideoSourceRecoveryAction = 'start' | 'wait' | 'skip';

// An `in_progress` durable source handoff is normally settled within the
// server's five-second resolution bound. Retry the media GET—not recovery
// POST—on a short, finite backoff so another replica's winner can be adopted
// without turning this expected race into a visible playback failure.
const sharedVideoHandoffRetryDelaysMs = [300, 700, 1_500, 3_000, 5_000] as const;

export function shouldAwaitSharedVideoHandoff(code: unknown): boolean {
  return code === 'remote_unavailable';
}

export function sharedVideoHandoffRetryDelay(input: {
  isContinuousRecording: boolean;
  reachedCanPlay: boolean;
  retryAttempt: number;
}): number | undefined {
  if (
    input.isContinuousRecording ||
    input.reachedCanPlay ||
    !Number.isSafeInteger(input.retryAttempt) ||
    input.retryAttempt < 0
  ) {
    return undefined;
  }
  return sharedVideoHandoffRetryDelaysMs[input.retryAttempt];
}

/**
 * Native media events from a keyed element can arrive after React has queued a
 * replacement. A synchronous generation fence makes those late `error` and
 * `canplay` events inert before the next element is committed.
 */
export function isCurrentPlaybackGeneration(input: {
  eventGeneration: string | undefined;
  currentGeneration: number;
}): boolean {
  return input.eventGeneration === String(input.currentGeneration);
}

/**
 * A `canplay` event only means that a browser has buffered enough data to
 * render the current position. A continuous recording uses a one-claim stream
 * ticket, so if the native media stack abandons that opening before the clock
 * advances, one fresh ticket is safer than exposing a generic source error.
 * Never restart after actual playback has advanced: that would lose the
 * viewer's place in a long recording.
 */
export function shouldRetryUnstartedContinuousRecording(input: {
  isContinuousRecording: boolean;
  hasPlaybackSource: boolean;
  hasMeaningfulPlayback: boolean;
  automaticTicketRetryUsed: boolean;
}): boolean {
  return (
    input.isContinuousRecording &&
    input.hasPlaybackSource &&
    !input.hasMeaningfulPlayback &&
    !input.automaticTicketRetryUsed
  );
}

/**
 * A continuous recording has no media element until its opaque, single-use
 * ticket is issued. A transient eVault source-read failure at that point is
 * therefore safe to retry once with a *new* ticket: no bytes have been
 * exposed and no ticket can have been claimed by the native player yet.
 *
 * Keep this deliberately narrower than the media-element recovery above.
 * Terminal denials, malformed grants, and repeated remote failures must
 * remain visible rather than silently creating an unbounded sequence of
 * source authorization requests.
 */
export function shouldRetryInitialContinuousRecordingTicket(input: {
  isContinuousRecording: boolean;
  errorCode: unknown;
  automaticTicketRetryUsed: boolean;
}): boolean {
  return (
    input.isContinuousRecording &&
    input.errorCode === 'remote_unavailable' &&
    !input.automaticTicketRetryUsed
  );
}

/**
 * Give the eVault's completed shared-proof cache a moment to settle before
 * the one automatic fresh ticket. This is not a user-visible backoff loop;
 * it only covers the source-zero handoff race and is intentionally finite.
 */
export const initialContinuousRecordingTicketRetryDelayMs = 300;

/**
 * Keep a native-media error from turning into either an unbounded retry loop
 * or a second generic failure while the one permitted reauthorization request
 * is still in flight. Continuous recordings own a separate ticket recovery
 * path and must never use this single-file path.
 */
export function singleVideoSourceRecoveryAction(input: {
  hasStreamId: boolean;
  isContinuousRecording: boolean;
  reachedCanPlay: boolean;
  automaticRecoveryUsed: boolean;
  recoveryInFlight: boolean;
}): SingleVideoSourceRecoveryAction {
  if (!input.hasStreamId || input.isContinuousRecording || input.reachedCanPlay) return 'skip';
  if (input.recoveryInFlight) return 'wait';
  return input.automaticRecoveryUsed ? 'skip' : 'start';
}

/**
 * Keep user-facing recovery text finite and source-safe. Route handlers expose
 * only these stable codes; raw upstream errors, private URLs, and opaque
 * stream identifiers must never reach the watch page.
 */
export function playbackFailureForAuthorizationCode(code: unknown): PlaybackFailure {
  switch (code) {
    case 'authorization_denied':
      return {
        title: 'You no longer have access to this video',
        description:
          'The original shared source no longer authorizes this account. Ask the owner to share it again.',
      };
    case 'not_found':
      return {
        title: 'The original video is no longer available',
        description:
          'The source file could not be found. It may have been removed or moved by its owner.',
      };
    case 'stream_expired':
    case 'invalid_stream':
      return {
        title: 'The private playback link expired',
        description:
          'Return to your video space and open the video again to get a fresh private link.',
      };
    case 'rate_limited':
    case 'remote_unavailable':
    case 'remote_rejected':
      return {
        title: 'The original video source is temporarily unavailable',
        description:
          'Vidak could not reach the source right now. Retry playback shortly; report it if the problem continues.',
      };
    default:
      return {
        title: 'Video source is unavailable',
        description:
          'Vidak could not refresh the private source for this video. Retry playback once, or report the problem if it continues.',
      };
  }
}
