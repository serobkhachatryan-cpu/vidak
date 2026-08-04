import { cx, focusRing } from './styles';
import {
  canNavigateToUploadStep,
  type UploadStepId,
  uploadStepLabels,
  uploadStepOrder,
} from './upload-constants';

export interface UploadStepperProps {
  activeStep: UploadStepId;
  completedSteps?: readonly UploadStepId[];
  onStepSelect?: (step: UploadStepId) => void;
}

export function UploadStepper({
  activeStep,
  completedSteps = [],
  onStepSelect,
}: UploadStepperProps) {
  const activeIndex = uploadStepOrder.indexOf(activeStep);

  return (
    <ol
      aria-label="Upload steps"
      className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-1"
    >
      {uploadStepOrder.map((step, index) => {
        const isActive = step === activeStep;
        const isComplete = completedSteps.includes(step) || index < activeIndex;
        const canSelect =
          Boolean(onStepSelect) &&
          canNavigateToUploadStep({ target: step, activeStep, completedSteps });

        return (
          <li key={step} className="flex min-w-0 items-center gap-2 sm:gap-1">
            <button
              type="button"
              disabled={!canSelect}
              aria-current={isActive ? 'step' : undefined}
              onClick={() => onStepSelect?.(step)}
              className={cx(
                'inline-flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left font-sans text-sm transition-colors duration-fast disabled:cursor-default',
                focusRing,
                isActive && 'bg-muted font-semibold text-foreground',
                !isActive && isComplete && 'text-foreground hover:bg-muted',
                !isActive && !isComplete && 'text-muted-foreground',
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  isActive && 'border-primary bg-primary text-primary-foreground',
                  !isActive && isComplete && 'border-success bg-success text-success-foreground',
                  !isActive && !isComplete && 'border-border bg-surface text-muted-foreground',
                )}
              >
                {isComplete && !isActive ? '✓' : index + 1}
              </span>
              <span className="truncate">
                {uploadStepLabels[step]}
                {isComplete && !isActive ? <span className="sr-only"> (completed)</span> : null}
              </span>
            </button>
            {index < uploadStepOrder.length - 1 && (
              <span aria-hidden="true" className="hidden text-muted-foreground sm:inline">
                /
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
