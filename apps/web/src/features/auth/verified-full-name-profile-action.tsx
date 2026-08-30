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
        setError(result.message);
        return;
      }
      setError(undefined);
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
    try {
      const consent = await fetchVerifiedFullNameConsent();
      if (consent.kind === 'unavailable' || consent.kind === 'hidden') {
        setError(consent.message ?? 'Your verified name is not available right now.');
        if (consent.kind === 'hidden') setVisible(false);
        return;
      }
      const result = await submitVerifiedFullNameGrant(true);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (user && result.user) updateSessionUser({ ...user, ...result.user });
      setVisible(false);
    } catch {
      setError('Your verified name is not available right now.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        isLoading={saving}
        loadingText="Using verified name"
        onClick={() => void apply()}
      >
        Use verified name from eID
      </Button>
      {error ? (
        <Text size="sm" tone="danger" role="status">
          {error}
        </Text>
      ) : (
        <Text size="sm" tone="muted">
          Uses the full name from your verified identity document. This will not overwrite a name
          you already chose.
        </Text>
      )}
    </div>
  );
}
