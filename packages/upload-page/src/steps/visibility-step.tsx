'use client';

import type { VideoVisibility } from '@w3ds/types';
import { Radio, Text } from '@w3ds/ui';
import { useId } from 'react';
import { cx } from '../styles';
import { visibilityOptions } from '../upload-constants';

export function VisibilityStep({
  value,
  error,
  onChange,
}: {
  value?: VideoVisibility | '';
  error?: string;
  onChange?: (visibility: VideoVisibility) => void;
}) {
  const groupId = useId();

  return (
    <div className="space-y-4">
      <Text size="sm" tone="muted">
        Choose who can find and watch this video after you publish.
      </Text>
      <div
        role="radiogroup"
        aria-labelledby={`${groupId}-label`}
        aria-describedby={error ? `${groupId}-error` : undefined}
        className="space-y-3"
      >
        <Text id={`${groupId}-label`} className="sr-only">
          Visibility
        </Text>
        {visibilityOptions.map((option) => {
          const optionId = `${groupId}-${option.value}`;
          const selected = value === option.value;
          return (
            <div
              key={option.value}
              className={cx(
                'flex gap-3 rounded-lg border border-border bg-surface p-4 transition-colors duration-fast',
                selected && 'border-primary bg-muted',
              )}
            >
              <Radio
                id={optionId}
                name={`${groupId}-visibility`}
                value={option.value}
                checked={selected}
                onChange={() => onChange?.(option.value)}
                aria-describedby={`${optionId}-description`}
              />
              <div className="min-w-0 space-y-1">
                <label
                  htmlFor={optionId}
                  className="block font-sans text-sm font-semibold text-foreground"
                >
                  {option.label}
                </label>
                <Text id={`${optionId}-description`} size="sm" tone="muted">
                  {option.description}
                </Text>
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <Text id={`${groupId}-error`} size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
