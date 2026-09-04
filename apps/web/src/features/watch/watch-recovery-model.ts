export const reportPlaybackProblemLabel = 'Report a playback problem';

export function watchRecoveryActionLabels(primaryLabel: string, secondaryLabel?: string) {
  return [primaryLabel, ...(secondaryLabel ? [secondaryLabel] : []), reportPlaybackProblemLabel];
}
