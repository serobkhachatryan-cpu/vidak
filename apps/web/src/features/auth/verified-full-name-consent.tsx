'use client';

import { Button, Card, Heading, Text } from '@w3ds/ui';
import { useEffect, useState } from 'react';
import { useAuthentication } from './auth-provider';

type ConsentState = 'hidden' | 'prompt' | 'saving' | 'error';

/**
 * First-login prompt. The verified passport name is read from the person's
 * eVault only after they grant permission — never during w3ds://auth.
 */
export function VerifiedFullNameConsent() {
  const { provider, user, updateSessionUser } = useAuthentication();
  const [state, setState] = useState<ConsentState>('hidden');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (provider !== 'w3ds' || !user?.eName) return;
    let cancelled = false;
    void fetch('/api/auth/verified-full-name', { credentials: 'include', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return { eligible: false };
        return (await response.json()) as { eligible?: boolean };
      })
      .then((consent) => {
        if (!cancelled && consent.eligible) setState('prompt');
      })
      .catch(() => {
        // Fail closed: do not prompt when the consent status cannot be read.
      });
    return () => {
      cancelled = true;
    };
  }, [provider, user?.eName, user?.id]);

  if (state === 'hidden') return null;

  const respond = async (grant: boolean) => {
    setError(undefined);
    setState('saving');
    try {
      const response = await fetch('/api/auth/verified-full-name', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant }),
      });
      const body = (await response.json().catch(() => undefined)) as
        | { user?: { displayName?: string }; error?: { message?: string } }
        | undefined;
      if (!response.ok) {
        setError(body?.error?.message ?? 'The verified name could not be used.');
        setState('error');
        return;
      }
      if (grant && user && body?.user) updateSessionUser({ ...user, ...body.user });
      setState('hidden');
    } catch {
      setError('The verified name could not be used.');
      setState('error');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="verified-full-name-title"
    >
      <Card elevated className="w-full max-w-md space-y-4 p-6">
        <Heading as="h2" size="lg" id="verified-full-name-title">
          Use your verified full name?
        </Heading>
        <Text>
          Your eID stores the full name from your verified identity document in your eVault. Vidak
          will use that name as your public name only if you allow it.
        </Text>
        {error ? (
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
          <Button
            type="button"
            isLoading={state === 'saving'}
            loadingText="Using verified name"
            onClick={() => void respond(true)}
          >
            Use verified name
          </Button>
        </div>
      </Card>
    </div>
  );
}
