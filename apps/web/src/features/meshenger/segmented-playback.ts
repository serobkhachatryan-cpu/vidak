type SegmentDuration = number | undefined;

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

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
