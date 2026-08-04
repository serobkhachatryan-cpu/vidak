'use client';

import type { PrivacySettings } from '@w3ds/types';
import { Switch, Text } from '@w3ds/ui';
import { privacySettingLabels } from '../settings-constants';

const privacyKeys = Object.keys(privacySettingLabels) as (keyof PrivacySettings)[];

export interface PrivacySectionProps {
  value: PrivacySettings;
  error?: string;
  onToggle: (key: keyof PrivacySettings, checked: boolean) => void;
}

export function PrivacySection({ value, error, onToggle }: PrivacySectionProps) {
  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {privacyKeys.map((key) => (
          <li
            key={key}
            className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-3"
          >
            <Text size="sm">{privacySettingLabels[key]}</Text>
            <Switch
              checked={value[key]}
              aria-label={privacySettingLabels[key]}
              onCheckedChange={(checked) => onToggle(key, checked)}
            />
          </li>
        ))}
      </ul>
      {error && (
        <Text size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
