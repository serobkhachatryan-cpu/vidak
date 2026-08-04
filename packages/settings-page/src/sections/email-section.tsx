'use client';

import { Button, Input, Label, Text } from '@w3ds/ui';
import { useId } from 'react';
import type { EmailFormErrors, EmailFormInput } from '../settings-validation';

export interface EmailSectionProps {
  currentEmail: string;
  value: EmailFormInput;
  errors?: EmailFormErrors;
  formError?: string;
  successMessage?: string;
  isSaving?: boolean;
  onChange: (patch: Partial<EmailFormInput>) => void;
  onSubmit: () => void;
}

export function EmailSection({
  currentEmail,
  value,
  errors,
  formError,
  successMessage,
  isSaving = false,
  onChange,
  onSubmit,
}: EmailSectionProps) {
  const emailId = useId();
  const passwordId = useId();

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Text size="sm" tone="muted">
        Current email: <span className="font-semibold text-foreground">{currentEmail}</span>
      </Text>
      <div className="space-y-2">
        <Label htmlFor={emailId}>New email</Label>
        <Input
          id={emailId}
          type="email"
          value={value.email}
          invalid={Boolean(errors?.email)}
          aria-describedby={errors?.email ? `${emailId}-error` : undefined}
          autoComplete="email"
          onChange={(event) => onChange({ email: event.target.value })}
        />
        {errors?.email && (
          <Text id={`${emailId}-error`} size="sm" tone="danger" role="alert">
            {errors.email}
          </Text>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={passwordId}>Current password</Label>
        <Input
          id={passwordId}
          type="password"
          value={value.password}
          invalid={Boolean(errors?.password)}
          aria-describedby={errors?.password ? `${passwordId}-error` : undefined}
          autoComplete="current-password"
          onChange={(event) => onChange({ password: event.target.value })}
        />
        {errors?.password && (
          <Text id={`${passwordId}-error`} size="sm" tone="danger" role="alert">
            {errors.password}
          </Text>
        )}
      </div>
      {formError && (
        <Text size="sm" tone="danger" role="alert">
          {formError}
        </Text>
      )}
      {successMessage && (
        <Text size="sm" tone="success" role="status">
          {successMessage}
        </Text>
      )}
      <Button type="submit" isLoading={isSaving} loadingText="Updating">
        Update email
      </Button>
    </form>
  );
}
