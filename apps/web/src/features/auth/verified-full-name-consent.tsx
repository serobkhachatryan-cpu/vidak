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

type ConsentState = Extract<VerifiedFullNameUiKind, 'hidden' | 'prompt' | 'unavailable'> | 'saving';

/**
 * First-login prompt. Uses the authenticated session provider, not the
 * build-time client provider, so a W3DS cookie session is enough.
 */
export function VerifiedFullNameConsent() {
  const { user, session, updateSessionUser } = useAuthentication();
  const [state, setState] = useState<ConsentState>('hidden');
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (
      !shouldCheckVerifiedFullName({ sessionProvider: session?.provider, hasUser: Boolean(user) })
    ) {
      return;
    }
    try {
      const result = await fetchVerifiedFullNameConsent();
      if (result.kind === 'prompt' || result.kind === 'unavailable') {
        setError(result.message);
        setState(result.kind);
        return;
      }
      setError(undefined);
      setState('hidden');
    } catch {
      setError('Your verified name is not available right now.');
      setState('unavailable');
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
    setState('saving');
    const result = await submitVerifiedFullNameGrant(grant);
    if (!result.ok) {
      setError(result.message);
      setState(grant ? 'unavailable' : 'prompt');
      return;
    }
    if (grant && user && result.user) updateSessionUser({ ...user, ...result.user });
    setState('hidden');
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
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            disabled={state === 'saving'}
            onClick={() => void respond(false)}
          >
            Not now
          </Button>
          {unavailable ? (
            <Button type="button" onClick={() => void load()}>
              Try again
            </Button>
          ) : (
            <Button
              type="button"
              isLoading={state === 'saving'}
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
