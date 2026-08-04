'use client';

import { Button, Input, Label, Text } from '@w3ds/ui';
import { useId } from 'react';
import type { PasswordFormErrors, PasswordFormInput } from '../settings-validation';

export interface PasswordSectionProps {
  value: PasswordFormInput;
  errors?: PasswordFormErrors;
  formError?: string;
  successMessage?: string;
  isSaving?: boolean;
  onChange: (patch: Partial<PasswordFormInput>) => void;
  onSubmit: () => void;
}

export function PasswordSection({
  value,
  errors,
  formError,
  successMessage,
  isSaving = false,
  onChange,
  onSubmit,
}: PasswordSectionProps) {
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={currentId}>Current password</Label>
        <Input
          id={currentId}
          type="password"
          value={value.currentPassword}
          invalid={Boolean(errors?.currentPassword)}
          aria-describedby={errors?.currentPassword ? `${currentId}-error` : undefined}
          autoComplete="current-password"
          onChange={(event) => onChange({ currentPassword: event.target.value })}
        />
        {errors?.currentPassword && (
          <Text id={`${currentId}-error`} size="sm" tone="danger" role="alert">
            {errors.currentPassword}
          </Text>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={nextId}>New password</Label>
        <Input
          id={nextId}
          type="password"
          value={value.newPassword}
          invalid={Boolean(errors?.newPassword)}
          aria-describedby={errors?.newPassword ? `${nextId}-error` : undefined}
          autoComplete="new-password"
          minLength={8}
          onChange={(event) => onChange({ newPassword: event.target.value })}
        />
        {errors?.newPassword && (
          <Text id={`${nextId}-error`} size="sm" tone="danger" role="alert">
            {errors.newPassword}
          </Text>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={confirmId}>Confirm new password</Label>
        <Input
          id={confirmId}
          type="password"
          value={value.confirmPassword}
          invalid={Boolean(errors?.confirmPassword)}
          aria-describedby={errors?.confirmPassword ? `${confirmId}-error` : undefined}
          autoComplete="new-password"
          onChange={(event) => onChange({ confirmPassword: event.target.value })}
        />
        {errors?.confirmPassword && (
          <Text id={`${confirmId}-error`} size="sm" tone="danger" role="alert">
            {errors.confirmPassword}
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
        Change password
      </Button>
    </form>
  );
}
