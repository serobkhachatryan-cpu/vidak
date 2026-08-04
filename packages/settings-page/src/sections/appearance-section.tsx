'use client';

import type { AppearancePreference } from '@w3ds/types';
import { Radio, Text } from '@w3ds/ui';
import { useId } from 'react';
import { appearanceOptions } from '../settings-constants';
import { cx } from '../styles';

export interface AppearanceSectionProps {
  value: AppearancePreference;
  error?: string;
  onChange: (appearance: AppearancePreference) => void;
}

export function AppearanceSection({ value, error, onChange }: AppearanceSectionProps) {
  const groupId = useId();

  return (
    <div className="space-y-4">
      <div
        role="radiogroup"
        aria-labelledby={`${groupId}-label`}
        className="grid gap-3 sm:grid-cols-3"
      >
        <span id={`${groupId}-label`} className="sr-only">
          Appearance
        </span>
        {appearanceOptions.map((option) => {
          const selected = value === option.value;
          const optionId = `${groupId}-${option.value}`;
          return (
            <div
              key={option.value}
              className={cx(
                'rounded-md border border-border p-4 transition-colors duration-fast',
                selected ? 'border-primary bg-muted' : 'hover:border-muted-foreground',
              )}
            >
              <div className="flex items-start gap-3">
                <Radio
                  id={optionId}
                  name={`${groupId}-appearance`}
                  checked={selected}
                  onChange={() => onChange(option.value)}
                  label={
                    <span className="space-y-1">
                      <Text className="font-semibold">{option.label}</Text>
                      <Text size="sm" tone="muted">
                        {option.description}
                      </Text>
                    </span>
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <Text size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
