type SegmentDuration = number | undefined;

export interface RecordingPosition {
  segmentIndex: number;
  seconds: number;
}

export function totalRecordingDuration(
  declaredDurationSeconds: number | undefined,
  segmentDurations: readonly SegmentDuration[],
): number | undefined {
  if (isDuration(declaredDurationSeconds)) return declaredDurationSeconds;
  const total = segmentDurations.filter(isDuration).reduce((sum, duration) => sum + duration, 0);
  return total > 0 ? total : undefined;
}

export function elapsedRecordingDuration(
  segmentIndex: number,
  currentSegmentSeconds: number,
  segmentDurations: readonly SegmentDuration[],
): number {
  const completedDuration = segmentDurations
    .slice(0, Math.max(0, segmentIndex))
    .filter(isDuration)
    .reduce((sum, duration) => sum + duration, 0);
  return completedDuration + (isDuration(currentSegmentSeconds) ? currentSegmentSeconds : 0);
}

/**
 * A call recording can be stored as several source files, but it is one
 * recording to the viewer. A complete duration map lets the player expose a
 * single seek bar without guessing which source file contains a timestamp.
 */
export function recordingTimelineDuration(
  segmentDurations: readonly SegmentDuration[],
): number | undefined {
  if (!segmentDurations.length || !segmentDurations.every(isPositiveDuration)) return undefined;
  return segmentDurations.reduce((sum, duration) => sum + duration, 0);
}

/** Maps a recording-level timestamp onto its private source file and offset. */
export function recordingPositionAt(
  seconds: number,
  segmentDurations: readonly SegmentDuration[],
): RecordingPosition | undefined {
  const duration = recordingTimelineDuration(segmentDurations);
  if (duration === undefined) return undefined;

  const target = Math.min(Math.max(0, seconds), duration);
  let elapsed = 0;
  for (let index = 0; index < segmentDurations.length; index += 1) {
    const segmentDuration = segmentDurations[index];
    if (segmentDuration === undefined) return undefined;
    const isLastSegment = index === segmentDurations.length - 1;
    if (target < elapsed + segmentDuration || isLastSegment) {
      return {
        segmentIndex: index,
        seconds: Math.min(Math.max(0, target - elapsed), segmentDuration),
      };
    }
    elapsed += segmentDuration;
  }
  return undefined;
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveDuration(value: unknown): value is number {
  return isDuration(value) && value > 0;
}
