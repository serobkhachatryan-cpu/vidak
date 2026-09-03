'use client';

import type { LoginChallengeStatus } from '@w3ds/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildOfferContinuePath } from './auth-session-handoff';
import { eidSignInCopy } from './eid-sign-in-copy';
import { useW3dsOfferPolling } from './w3ds-offer-polling';

async function readOfferStatus(offerId: string): Promise<LoginChallengeStatus> {
  const response = await fetch(`/api/auth/offer/${encodeURIComponent(offerId)}/status`, {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const status = (await response.json().catch(() => undefined)) as LoginChallengeStatus | undefined;
  if (!response.ok || !status) throw new Error('The eID request status is unavailable.');
  return status;
}

/**
 * Completes a server-rendered eID offer without reloading the login page.
 * The old meta-refresh navigation recreated the page and QR code every two
 * seconds, which made the screen visibly flicker while a wallet was open.
 */
export function W3dsServerOfferPoller({
  offerId,
  returnTo,
}: {
  offerId: string;
  returnTo: string;
}) {
  const [message, setMessage] = useState<string>(eidSignInCopy.waiting);
  const hasNavigated = useRef(false);
  useEffect(() => {
    hasNavigated.current = false;
    setMessage(eidSignInCopy.waiting);
  }, [offerId]);
  const handleStatus = useCallback(
    (status: LoginChallengeStatus) => {
      if (status.status === 'completed' && !hasNavigated.current) {
        hasNavigated.current = true;
        window.location.assign(buildOfferContinuePath(offerId, returnTo));
        return;
      }
      if (status.status === 'expired') {
        setMessage(eidSignInCopy.requestExpired);
        return;
      }
      if (status.status === 'failed') {
        setMessage(eidSignInCopy.requestFailed);
        return;
      }
      setMessage(eidSignInCopy.checking);
    },
    [offerId, returnTo],
  );
  const handleError = useCallback(() => {
    setMessage('We could not check this eID request. Keep this page open or create a new request.');
  }, []);

  useW3dsOfferPolling({
    offerId,
    readStatus: readOfferStatus,
    onStatus: handleStatus,
    onError: handleError,
    retryOnError: true,
  });

  return (
    <p className="font-sans text-sm text-muted-foreground" role="status" aria-live="polite">
      {message}
    </p>
  );
}
