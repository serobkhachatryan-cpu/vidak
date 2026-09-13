import { describe, expect, it } from 'vitest';

import {
  isCurrentPlaybackGeneration,
  playbackFailureForAuthorizationCode,
  sharedVideoHandoffRetryDelay,
  shouldAwaitSharedVideoHandoff,
  singleVideoSourceRecoveryAction,
} from './watch-playback-recovery';

describe('watch playback recovery copy', () => {
  it.each([
    ['authorization_denied', 'You no longer have access to this video'],
    ['not_found', 'The original video is no longer available'],
    ['stream_expired', 'The private playback link expired'],
    ['invalid_stream', 'The private playback link expired'],
    ['rate_limited', 'The original video source is temporarily unavailable'],
    ['remote_unavailable', 'The original video source is temporarily unavailable'],
    ['remote_rejected', 'The original video source is temporarily unavailable'],
    ['unexpected_backend_text', 'Video source is unavailable'],
  ])('maps %s to safe actionable copy', (code, title) => {
    const failure = playbackFailureForAuthorizationCode(code);
    expect(failure.title).toBe(title);
    expect(failure.description).not.toContain(code);
  });
});

describe('single-video source recovery policy', () => {
  const base = {
    hasStreamId: true,
    isContinuousRecording: false,
    reachedCanPlay: false,
    automaticRecoveryUsed: false,
    recoveryInFlight: false,
  };

  it('starts exactly one pre-playback recovery', () => {
    expect(singleVideoSourceRecoveryAction(base)).toBe('start');
    expect(singleVideoSourceRecoveryAction({ ...base, automaticRecoveryUsed: true })).toBe('skip');
  });

  it('waits for the existing recovery instead of replacing it with an error', () => {
    expect(
      singleVideoSourceRecoveryAction({
        ...base,
        automaticRecoveryUsed: true,
        recoveryInFlight: true,
      }),
    ).toBe('wait');
  });

  it.each([{ hasStreamId: false }, { isContinuousRecording: true }, { reachedCanPlay: true }])(
    'does not apply the single-file recovery to %o',
    (override) => {
      expect(singleVideoSourceRecoveryAction({ ...base, ...override })).toBe('skip');
    },
  );
});

describe('shared source handoff waiting policy', () => {
  it('waits only for the bounded recoverable handoff response', () => {
    expect(shouldAwaitSharedVideoHandoff('remote_unavailable')).toBe(true);
    expect(shouldAwaitSharedVideoHandoff('authorization_denied')).toBe(false);
    expect(shouldAwaitSharedVideoHandoff(undefined)).toBe(false);
  });

  it('uses a finite media-only retry backoff before surfacing a failure', () => {
    const delays = Array.from({ length: 5 }, (_, retryAttempt) =>
      sharedVideoHandoffRetryDelay({
        isContinuousRecording: false,
        reachedCanPlay: false,
        retryAttempt,
      }),
    );
    expect(delays).toEqual([300, 700, 1_500, 3_000, 5_000]);
    expect(
      sharedVideoHandoffRetryDelay({
        isContinuousRecording: false,
        reachedCanPlay: false,
        retryAttempt: delays.length,
      }),
    ).toBeUndefined();
  });

  it.each([{ isContinuousRecording: true }, { reachedCanPlay: true }, { retryAttempt: -1 }])(
    'does not schedule a handoff retry for %o',
    (override) => {
      expect(
        sharedVideoHandoffRetryDelay({
          isContinuousRecording: false,
          reachedCanPlay: false,
          retryAttempt: 0,
          ...override,
        }),
      ).toBeUndefined();
    },
  );

  it('fences a late media event immediately when a retry queues a replacement', () => {
    const oldGeneration = 8;
    const nextGeneration = oldGeneration + 1;
    expect(
      isCurrentPlaybackGeneration({
        eventGeneration: String(oldGeneration),
        currentGeneration: nextGeneration,
      }),
    ).toBe(false);
    expect(
      isCurrentPlaybackGeneration({
        eventGeneration: String(nextGeneration),
        currentGeneration: nextGeneration,
      }),
    ).toBe(true);
  });
});
