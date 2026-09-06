import { describe, expect, it } from 'vitest';
import {
  elapsedRecordingDuration,
  recordingPositionAt,
  recordingTimelineDuration,
  totalRecordingDuration,
} from './segmented-playback';

describe('segmented Meshenger playback', () => {
  it('uses the call-level duration when Meshenger supplies one', () => {
    expect(totalRecordingDuration(180, [60, 60, 60])).toBe(180);
  });

  it('derives a total duration from known segment metadata when necessary', () => {
    expect(totalRecordingDuration(undefined, [60, undefined, 45])).toBe(105);
  });

  it('tracks a person’s position across completed recording segments', () => {
    expect(elapsedRecordingDuration(2, 17, [45, 50, 60])).toBe(112);
  });

  it('does not turn unknown or invalid media timing into false progress', () => {
    expect(elapsedRecordingDuration(1, Number.NaN, [30, undefined])).toBe(30);
    expect(totalRecordingDuration(undefined, [undefined, Number.NaN])).toBeUndefined();
  });

  it('builds one seekable timeline when every source duration is known', () => {
    expect(recordingTimelineDuration([45, 50, 60])).toBe(155);
    expect(recordingPositionAt(112, [45, 50, 60])).toEqual({ segmentIndex: 2, seconds: 17 });
    expect(recordingPositionAt(155, [45, 50, 60])).toEqual({ segmentIndex: 2, seconds: 60 });
  });

  it('never guesses a source position before the recording timeline is known', () => {
    expect(recordingTimelineDuration([45, undefined, 60])).toBeUndefined();
    expect(recordingPositionAt(50, [45, undefined, 60])).toBeUndefined();
  });
});
