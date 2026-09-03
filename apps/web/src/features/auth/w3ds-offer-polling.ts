'use client';

import type { LoginChallengeStatus } from '@w3ds/auth';
import { useEffect, useRef } from 'react';

export const w3dsOfferPollIntervalMs = 2_000;

type ReadOfferStatus = (offerId: string) => Promise<LoginChallengeStatus>;

/** Pending offers are the only statuses that may schedule another request. */
export function shouldContinueW3dsOfferPolling(status: LoginChallengeStatus): boolean {
  return status.status === 'pending';
}

/**
 * Polls one eID offer at a time. A recursive timeout deliberately replaces
 * intervals so a slow response never overlaps the next request.
 */
export function useW3dsOfferPolling({
  offerId,
  readStatus,
  onStatus,
  onError,
  retryOnError = false,
}: {
  offerId: string | undefined;
  readStatus: ReadOfferStatus;
  onStatus: (status: LoginChallengeStatus) => void;
  onError: (error: unknown) => void;
  retryOnError?: boolean;
}) {
  const readStatusRef = useRef(readStatus);
  const onStatusRef = useRef(onStatus);
  const onErrorRef = useRef(onError);
  const retryOnErrorRef = useRef(retryOnError);

  readStatusRef.current = readStatus;
  onStatusRef.current = onStatus;
  onErrorRef.current = onError;
  retryOnErrorRef.current = retryOnError;

  useEffect(() => {
    if (!offerId) return;

    let cancelled = false;
    let timeout: number | undefined;
    const schedule = () => {
      timeout = window.setTimeout(() => void poll(), w3dsOfferPollIntervalMs);
    };
    const poll = async () => {
      try {
        const status = await readStatusRef.current(offerId);
        if (cancelled) return;

        onStatusRef.current(status);
        if (shouldContinueW3dsOfferPolling(status)) schedule();
      } catch (error) {
        if (cancelled) return;
        onErrorRef.current(error);
        if (retryOnErrorRef.current) schedule();
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [offerId]);
}
