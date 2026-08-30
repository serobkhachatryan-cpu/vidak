'use client';

import { Button, Card, Heading, Text } from '@w3ds/ui';
import { useCallback, useEffect, useState } from 'react';
import { useAuthentication } from './auth-provider';
import {
  fetchVerifiedFullNameConsent,
  shouldCheckVerifiedFullName,
  submitVerifiedFullNameGrant,
  type VerifiedFullNameUiKind,
} from './verified-full-name-client';

type ConsentState = Extract<VerifiedFullNameUiKind, 'hidden' | 'prompt' | 'unavailable'>;

/**
 * First-login prompt. Uses the authenticated session provider, not the
 * build-time client provider, so a W3DS cookie session is enough.
 */
export function VerifiedFullNameConsent() {
  const { user, session, updateSessionUser } = useAuthentication();
  const [state, setState] = useState<ConsentState>('hidden');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState<string>();
  const [retryLookup, setRetryLookup] = useState(false);

  const load = useCallback(async () => {
    if (
      !shouldCheckVerifiedFullName({ sessionProvider: session?.provider, hasUser: Boolean(user) })
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await fetchVerifiedFullNameConsent();
      if (result.kind === 'prompt' || result.kind === 'unavailable') {
        setError(result.message);
        setReason(result.reason);
        setRetryLookup(false);
        setState(result.kind);
        return;
      }
      setError(undefined);
      setReason(undefined);
      setState('hidden');
    } catch {
      setError('Your verified name is not available right now.');
      setReason('source_unavailable');
      setRetryLookup(false);
      setState('unavailable');
    } finally {
      setBusy(false);
    }
  }, [session?.provider, user]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'hidden') return null;

  const respond = async (grant: boolean) => {
    if (state === 'unavailable' && !grant) {
      setState('hidden');
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const result = await submitVerifiedFullNameGrant(grant);
      if (!result.ok) {
        setError(result.message);
        setReason(result.reason);
        if (grant) {
          setRetryLookup(true);
          setState('unavailable');
        } else {
          setState('prompt');
        }
        return;
      }
      if (grant && user && result.user) updateSessionUser({ ...user, ...result.user });
      setState('hidden');
    } finally {
      setBusy(false);
    }
  };

  const tryAgain = () => {
    if (retryLookup) void respond(true);
    else void load();
  };

  const unavailable = state === 'unavailable';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="verified-full-name-title"
    >
      <Card elevated className="w-full max-w-md space-y-4 p-6">
        <Heading as="h2" size="lg" id="verified-full-name-title">
          {unavailable ? 'Verified name unavailable' : 'Use your verified full name?'}
        </Heading>
        <Text>
          {unavailable
            ? (error ?? 'Your verified name is not available right now.')
            : 'Your eID stores the full name from your verified identity document in your eVault. Vidak will use that name as your public name only if you allow it.'}
        </Text>
        {error && !unavailable ? (
          <Text size="sm" tone="danger" role="alert">
            {error}
          </Text>
        ) : null}
        {unavailable && reason ? (
          <Text size="sm" tone="muted" role="status">
            Reason: {reason}
          </Text>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void respond(false)}>
            Not now
          </Button>
          {unavailable ? (
            <Button
              type="button"
              isLoading={busy}
              loadingText="Looking up verified name"
              onClick={() => void tryAgain()}
            >
              Try again
            </Button>
          ) : (
            <Button
              type="button"
              isLoading={busy}
              loadingText="Using verified name"
              onClick={() => void respond(true)}
            >
              Use verified name
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
