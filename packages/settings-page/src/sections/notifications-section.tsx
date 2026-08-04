'use client';

import type { NotificationPreferences } from '@w3ds/types';
import { Switch, Text } from '@w3ds/ui';
import { notificationPreferenceLabels } from '../settings-constants';

const notificationKeys = Object.keys(
  notificationPreferenceLabels,
) as (keyof NotificationPreferences)[];

export interface NotificationsSectionProps {
  value: NotificationPreferences;
  error?: string;
  onToggle: (key: keyof NotificationPreferences, checked: boolean) => void;
}

export function NotificationsSection({ value, error, onToggle }: NotificationsSectionProps) {
  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {notificationKeys.map((key) => (
          <li
            key={key}
            className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-3"
          >
            <Text size="sm">{notificationPreferenceLabels[key]}</Text>
            <Switch
              checked={value[key]}
              aria-label={notificationPreferenceLabels[key]}
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
