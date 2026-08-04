'use client';

import type { AppLanguage } from '@w3ds/types';
import { appLanguages } from '@w3ds/types';
import { Label, Select, Text } from '@w3ds/ui';
import { useId } from 'react';
import { appLanguageLabels } from '../settings-constants';

export interface LanguageSectionProps {
  value: AppLanguage;
  error?: string;
  successMessage?: string;
  onChange: (language: AppLanguage) => void;
}

export function LanguageSection({ value, error, successMessage, onChange }: LanguageSectionProps) {
  const languageId = useId();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={languageId}>Language</Label>
        <Select
          id={languageId}
          value={value}
          aria-label="Language"
          onChange={(event) => onChange(event.target.value as AppLanguage)}
        >
          {appLanguages.map((language) => (
            <option key={language} value={language}>
              {appLanguageLabels[language]}
            </option>
          ))}
        </Select>
      </div>
      {error && (
        <Text size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
      {successMessage && (
        <Text size="sm" tone="success" role="status">
          {successMessage}
        </Text>
      )}
    </div>
  );
}
