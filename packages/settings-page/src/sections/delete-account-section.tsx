'use client';

import { Button, Input, Label, Text } from '@w3ds/ui';
import { useId, useState } from 'react';
import { deleteAccountConfirmation } from '../settings-constants';
import type { DeleteAccountFormErrors, DeleteAccountFormInput } from '../settings-validation';

export interface DeleteAccountSectionProps {
  value: DeleteAccountFormInput;
  errors?: DeleteAccountFormErrors;
  formError?: string;
  isDeleting?: boolean;
  onChange: (patch: Partial<DeleteAccountFormInput>) => void;
  onDelete: () => void;
}

export function DeleteAccountSection({
  value,
  errors,
  formError,
  isDeleting = false,
  onChange,
  onDelete,
}: DeleteAccountSectionProps) {
  const passwordId = useId();
  const confirmationId = useId();
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-4 rounded-md border border-danger/40 bg-danger/5 p-4">
        <Text size="sm" tone="muted">
          Deleting your account removes your profile, videos, and settings. This cannot be undone.
        </Text>
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete account
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-5 rounded-md border border-danger/40 bg-danger/5 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onDelete();
      }}
    >
      <Text size="sm">
        Type <span className="font-semibold">{deleteAccountConfirmation}</span> and enter your
        password to permanently delete your account.
      </Text>
      <div className="space-y-2">
        <Label htmlFor={confirmationId}>Confirmation</Label>
        <Input
          id={confirmationId}
          value={value.confirmation}
          invalid={Boolean(errors?.confirmation)}
          aria-describedby={errors?.confirmation ? `${confirmationId}-error` : undefined}
          autoComplete="off"
          onChange={(event) => onChange({ confirmation: event.target.value })}
        />
        {errors?.confirmation && (
          <Text id={`${confirmationId}-error`} size="sm" tone="danger" role="alert">
            {errors.confirmation}
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
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" isLoading={isDeleting} loadingText="Deleting">
          Permanently delete
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={isDeleting}
          onClick={() => {
            setConfirming(false);
            onChange({ password: '', confirmation: '' });
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
