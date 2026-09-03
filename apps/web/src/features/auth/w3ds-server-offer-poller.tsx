'use client';

import { useEffect, useRef, useState } from 'react';
import { buildOfferContinuePath } from './auth-session-handoff';
import { eidSignInCopy } from './eid-sign-in-copy';

type OfferStatus =
  | { status: 'pending' }
  | { status: 'completed' }
  | { status: 'expired' }
  | { status: 'failed' };

const pollIntervalMs = 2_000;

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
    let disposed = false;
    let timeout: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/auth/offer/${encodeURIComponent(offerId)}/status`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const status = (await response.json().catch(() => undefined)) as OfferStatus | undefined;
        if (disposed) return;

        if (!response.ok || !status) {
          setMessage(
            'We could not check this eID request. Keep this page open or create a new request.',
          );
          timeout = window.setTimeout(() => void poll(), pollIntervalMs);
          return;
        }
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
        timeout = window.setTimeout(() => void poll(), pollIntervalMs);
      } catch {
        if (!disposed) {
          setMessage(
            'We could not check this eID request. Keep this page open or create a new request.',
          );
          timeout = window.setTimeout(() => void poll(), pollIntervalMs);
        }
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [offerId, returnTo]);

  return (
    <p className="font-sans text-sm text-muted-foreground" role="status" aria-live="polite">
      {message}
    </p>
  );
}
