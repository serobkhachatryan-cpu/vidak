import { describe, expect, it } from 'vitest';
import { reportPlaybackProblemLabel, watchRecoveryActionLabels } from './watch-recovery-model';

describe('watch recovery actions', () => {
  it('keeps retry, a safe exit, and private support available together', () => {
    expect(watchRecoveryActionLabels('Retry playback', 'Back to your video space')).toEqual([
      'Retry playback',
      'Back to your video space',
      reportPlaybackProblemLabel,
    ]);
  });

  it('does not add an empty secondary action', () => {
    expect(watchRecoveryActionLabels('Back to your video space')).toEqual([
      'Back to your video space',
      reportPlaybackProblemLabel,
    ]);
  });
});
