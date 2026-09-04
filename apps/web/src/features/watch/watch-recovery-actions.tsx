import { Button } from '@w3ds/ui';
import { reportPlaybackProblemLabel } from './watch-recovery-model';

interface WatchRecoveryActionsProps {
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  onReportProblem: () => void;
}

/**
 * Keeps every playback failure actionable: recover when possible, leave the
 * broken view, or send a private report with the current page as diagnostics.
 */
export function WatchRecoveryActions({
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  onReportProblem,
}: WatchRecoveryActionsProps) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button variant="secondary" onClick={onPrimary}>
        {primaryLabel}
      </Button>
      {secondaryLabel && onSecondary ? (
        <Button variant="ghost" onClick={onSecondary}>
          {secondaryLabel}
        </Button>
      ) : null}
      <Button variant="ghost" onClick={onReportProblem}>
        {reportPlaybackProblemLabel}
      </Button>
    </div>
  );
}
