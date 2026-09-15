import { afterEach, describe, expect, it } from 'vitest';
import {
  backgroundWorkDelayMs,
  beginBackgroundWork,
  reserveInteractivePlayback,
  reserveInteractiveSourceWork,
  resetBackgroundWorkPriorityForTests,
} from './background-work-priority';

describe('background playback priority', () => {
  afterEach(() => {
    resetBackgroundWorkPriorityForTests();
  });

  it('keeps resumable work paused for the latest interactive playback reservation', () => {
    reserveInteractivePlayback(30_000, 1_000);
    reserveInteractivePlayback(40_000, 10_000);

    expect(backgroundWorkDelayMs(10_000)).toBe(40_000);
    expect(backgroundWorkDelayMs(50_000)).toBe(0);
  });

  it('gives a short player warm-up the full bounded playback reservation', () => {
    reserveInteractivePlayback(5_000, 1_000);

    expect(backgroundWorkDelayMs(6_000)).toBe(25_000);

    // A later short request extends the fence from its own start rather than
    // allowing a catalogue poll to restart midway through playback startup.
    reserveInteractivePlayback(5_000, 10_000);
    expect(backgroundWorkDelayMs(10_000)).toBe(30_000);
  });

  it('preempts a registered resumable task when playback begins', () => {
    const lease = beginBackgroundWork();
    expect(lease.signal.aborted).toBe(false);

    reserveInteractivePlayback(30_000);

    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  it('does not start resumable work after playback has already reserved capacity', () => {
    reserveInteractivePlayback(30_000);

    const lease = beginBackgroundWork('@poster-source.w3id');

    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  it('preempts only background work from the watched source', () => {
    const watched = beginBackgroundWork('@watched.w3id');
    const other = beginBackgroundWork('@other.w3id');

    reserveInteractiveSourceWork('@WATCHED.w3id', 30_000);

    expect(watched.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    watched.release();
    other.release();
  });
});
