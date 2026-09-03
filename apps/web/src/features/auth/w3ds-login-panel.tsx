'use client';

import { AuthenticationError } from '@w3ds/auth';
import { Button, Text } from '@w3ds/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthentication } from './auth-provider';
import { buildOfferContinuePath } from './auth-session-handoff';
import { eidSignInCopy } from './eid-sign-in-copy';
import { SignInQr } from './sign-in-qr';
import {
  initialW3dsLoginState,
  reduceW3dsLoginChallenge,
  reduceW3dsLoginPollError,
  reduceW3dsLoginStart,
  reduceW3dsLoginStartError,
  reduceW3dsLoginStatus,
  type W3dsLoginUiState,
  w3dsLoginStatusMessage,
} from './w3ds-login-challenge';
import { useW3dsOfferPolling } from './w3ds-offer-polling';

function errorMessage(error: unknown) {
  return error instanceof AuthenticationError
    ? error.message
    : 'We could not start sign-in. Please try again.';
}

export function W3dsLoginPanel({ returnTo }: { returnTo: string }) {
  const { createLoginChallenge, getLoginChallengeStatus } = useAuthentication();
  const [state, setState] = useState<W3dsLoginUiState>(initialW3dsLoginState);
  const completedRef = useRef(false);
  const createLoginChallengeRef = useRef(createLoginChallenge);
  const getLoginChallengeStatusRef = useRef(getLoginChallengeStatus);

  createLoginChallengeRef.current = createLoginChallenge;
  getLoginChallengeStatusRef.current = getLoginChallengeStatus;

  const startChallenge = useCallback(async () => {
    completedRef.current = false;
    setState(reduceW3dsLoginStart());
    try {
      const challenge = await createLoginChallengeRef.current();
      setState(reduceW3dsLoginChallenge(challenge));
    } catch (error) {
      setState(reduceW3dsLoginStartError(errorMessage(error)));
    }
  }, []);

  useEffect(() => {
    void startChallenge();
  }, [startChallenge]);

  const pendingChallenge = state.kind === 'pending' ? state.challenge : undefined;
  const readOfferStatus = useCallback(
    async (offerId: string) => getLoginChallengeStatusRef.current(offerId),
    [],
  );
  const handleOfferStatus = useCallback(
    (status: Awaited<ReturnType<typeof readOfferStatus>>) => {
      if (!pendingChallenge) return;

      const next = reduceW3dsLoginStatus(pendingChallenge, status);
      setState(next);
      if (next.kind === 'completed' && !completedRef.current) {
        completedRef.current = true;
        // Always finish through the cookie-producing continuation, then the
        // handoff page verifies GET /api/auth/session before returnTo.
        window.location.assign(buildOfferContinuePath(pendingChallenge.offerId, returnTo));
      }
    },
    [pendingChallenge, readOfferStatus, returnTo],
  );
  const handleOfferError = useCallback(
    (error: unknown) => {
      if (!pendingChallenge) return;
      setState(reduceW3dsLoginPollError(pendingChallenge, errorMessage(error)));
    },
    [pendingChallenge],
  );

  useW3dsOfferPolling({
    offerId: pendingChallenge?.offerId,
    readStatus: readOfferStatus,
    onStatus: handleOfferStatus,
    onError: handleOfferError,
  });

  const statusMessage = w3dsLoginStatusMessage(state);
  const challenge =
    state.kind === 'pending' || state.kind === 'expired' || state.kind === 'failed'
      ? state.challenge
      : undefined;
  const showRetry = state.kind === 'expired' || state.kind === 'failed' || state.kind === 'error';
  const isAlert = state.kind === 'failed' || state.kind === 'expired' || state.kind === 'error';

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Text>{eidSignInCopy.intro}</Text>
        <Text size="sm" tone="muted">
          {eidSignInCopy.approveHint}
        </Text>
      </div>

      {statusMessage && (
        <div
          role="status"
          aria-live="polite"
          className={
            isAlert
              ? 'rounded-md border border-danger bg-danger/10 px-3 py-2 font-sans text-sm text-danger'
              : 'rounded-md border border-border bg-surface px-3 py-2 font-sans text-sm text-foreground'
          }
        >
          {statusMessage}
        </div>
      )}

      {challenge && (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <SignInQr value={challenge.signInUri} alt={eidSignInCopy.qrAlt} />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1.5">
              <Text size="sm" tone="muted">
                {eidSignInCopy.linkLabel}
              </Text>
              <a
                href={challenge.signInUri}
                className="block font-sans text-sm font-semibold text-primary hover:underline"
              >
                {eidSignInCopy.linkText}
              </a>
            </div>
            <Text size="xs" tone="muted">
              Expires {new Date(challenge.expiresAt).toLocaleTimeString()}
            </Text>
            {state.kind === 'pending' && (
              <Text size="sm" tone="muted">
                {eidSignInCopy.waiting}
              </Text>
            )}
          </div>
        </div>
      )}

      {(state.kind === 'idle' || state.kind === 'starting') && !challenge && (
        <Button
          type="button"
          className="w-full"
          isLoading={state.kind === 'starting'}
          loadingText="Starting"
        >
          {eidSignInCopy.continueButton}
        </Button>
      )}

      {showRetry && (
        <Button type="button" className="w-full" onClick={() => void startChallenge()}>
          {eidSignInCopy.retryButton}
        </Button>
      )}
    </div>
  );
}
