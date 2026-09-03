'use client';

import { Button, Text } from '@w3ds/ui';
import { useCallback, useEffect, useState } from 'react';
import { useAuthentication } from './auth-provider';
import {
  fetchVerifiedFullNameConsent,
  shouldCheckVerifiedFullName,
  submitVerifiedFullNameGrant,
} from './verified-full-name-client';

/**
 * Profile action that stays available after "Not now". Reads the name only
 * after an explicit grant.
 */
export function VerifiedFullNameProfileAction() {
  const { user, session, updateSessionUser } = useAuthentication();
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const load = useCallback(async () => {
    if (
      !shouldCheckVerifiedFullName({ sessionProvider: session?.provider, hasUser: Boolean(user) })
    ) {
      setVisible(false);
      return;
    }
    try {
      const result = await fetchVerifiedFullNameConsent();
      if (result.kind === 'unavailable') {
        setVisible(true);
        setError(result.reason ? `${result.message} (${result.reason})` : result.message);
        return;
      }
      setError(undefined);
      setSuccess(undefined);
      setVisible(result.kind === 'profile' || result.kind === 'prompt');
    } catch {
      setVisible(true);
      setError('Your verified name is not available right now.');
    }
  }, [session?.provider, user]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!visible) return null;

  const apply = async () => {
    setSaving(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      const result = await submitVerifiedFullNameGrant(true);
      if (!result.ok) {
        setError(result.reason ? `${result.message} (${result.reason})` : result.message);
        return;
      }
      if (user && result.user) updateSessionUser({ ...user, ...result.user });
      setSuccess(
        result.user?.displayName
          ? `Your Vidak profile now uses “${result.user.displayName}”.`
          : 'Your Vidak profile now uses your verified eID name.',
      );
    } catch {
      setError('Your verified name is not available right now.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Text size="sm" tone="muted">
        “Vidak member” is only a temporary profile label for this eID. It is not another account.
      </Text>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        isLoading={saving}
        loadingText="Updating profile name"
        onClick={() => void apply()}
      >
        Use my verified eID name
      </Button>
      {error ? (
        <Text size="sm" tone="danger" role="status">
          {error}
        </Text>
      ) : success ? (
        <Text size="sm" tone="success" role="status">
          {success}
        </Text>
      ) : (
        <Text size="sm" tone="muted">
          This copies the full name verified by your existing eID into your Vidak profile. It does
          not create another account and will not overwrite a name you already chose.
        </Text>
      )}
    </div>
  );
}
