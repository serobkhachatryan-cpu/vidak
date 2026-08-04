'use client';

import { AuthenticationError } from '@w3ds/auth';
import { Button, Text } from '@w3ds/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthentication } from './auth-provider';
import { SignInQr } from './sign-in-qr';
import {
  initialW3dsLoginState,
  isTerminalW3dsLoginState,
  reduceW3dsLoginChallenge,
  reduceW3dsLoginPollError,
  reduceW3dsLoginStart,
  reduceW3dsLoginStartError,
  reduceW3dsLoginStatus,
  type W3dsLoginUiState,
  w3dsLoginPollIntervalMs,
  w3dsLoginStatusMessage,
} from './w3ds-login-challenge';

function errorMessage(error: unknown) {
  return error instanceof AuthenticationError
    ? error.message
    : 'We could not start sign-in. Please try again.';
}

export function W3dsLoginPanel({ returnTo }: { returnTo: string }) {
  const { createLoginChallenge, getLoginChallengeStatus, acceptSession } = useAuthentication();
  const router = useRouter();
  const [state, setState] = useState<W3dsLoginUiState>(initialW3dsLoginState);
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const completedRef = useRef(false);
  const createLoginChallengeRef = useRef(createLoginChallenge);
  const getLoginChallengeStatusRef = useRef(getLoginChallengeStatus);
  const acceptSessionRef = useRef(acceptSession);

  createLoginChallengeRef.current = createLoginChallenge;
  getLoginChallengeStatusRef.current = getLoginChallengeStatus;
  acceptSessionRef.current = acceptSession;

  const clearPoll = useCallback(() => {
    if (pollTimer.current !== undefined) {
      clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    }
  }, []);

  const startChallenge = useCallback(async () => {
    clearPoll();
    completedRef.current = false;
    setState(reduceW3dsLoginStart());
    try {
      const challenge = await createLoginChallengeRef.current();
      setState(reduceW3dsLoginChallenge(challenge));
    } catch (error) {
      setState(reduceW3dsLoginStartError(errorMessage(error)));
    }
  }, [clearPoll]);

  useEffect(() => {
    void startChallenge();
    return clearPoll;
  }, [clearPoll, startChallenge]);

  const pendingOfferId = state.kind === 'pending' ? state.challenge.offerId : undefined;
  const pendingSignInUri = state.kind === 'pending' ? state.challenge.signInUri : undefined;
  const pendingExpiresAt = state.kind === 'pending' ? state.challenge.expiresAt : undefined;

  useEffect(() => {
    if (!pendingOfferId || !pendingSignInUri || !pendingExpiresAt) {
      clearPoll();
      return;
    }

    const challenge = {
      offerId: pendingOfferId,
      signInUri: pendingSignInUri,
      expiresAt: pendingExpiresAt,
    };

    const poll = async () => {
      try {
        const status = await getLoginChallengeStatusRef.current(challenge.offerId);
        const next = reduceW3dsLoginStatus(challenge, status);
        setState(next);

        if (next.kind === 'completed' && !completedRef.current) {
          completedRef.current = true;
          clearPoll();
          await acceptSessionRef.current(next.session);
          router.replace(returnTo);
          return;
        }

        if (isTerminalW3dsLoginState(next)) clearPoll();
      } catch (error) {
        setState(reduceW3dsLoginPollError(challenge, errorMessage(error)));
        clearPoll();
      }
    };

    void poll();
    pollTimer.current = setInterval(() => {
      void poll();
    }, w3dsLoginPollIntervalMs);

    return clearPoll;
  }, [clearPoll, pendingExpiresAt, pendingOfferId, pendingSignInUri, returnTo, router]);

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
        <Text>
          Continue with your eID wallet to sign in. Scan the code or open the sign-in link on this
          device.
        </Text>
        <Text size="sm" tone="muted">
          Approve the request in your eID wallet. This page finishes automatically when approval
          completes.
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
          <SignInQr value={challenge.signInUri} />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1.5">
              <Text size="sm" tone="muted">
                Sign-in link
              </Text>
              <a
                href={challenge.signInUri}
                className="block break-all font-sans text-sm font-semibold text-primary hover:underline"
              >
                {challenge.signInUri}
              </a>
            </div>
            <Text size="xs" tone="muted">
              Expires {new Date(challenge.expiresAt).toLocaleTimeString()}
            </Text>
            {state.kind === 'pending' && (
              <Text size="sm" tone="muted">
                Waiting for approval…
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
          Continue with eID
        </Button>
      )}

      {showRetry && (
        <Button type="button" className="w-full" onClick={() => void startChallenge()}>
          Try again
        </Button>
      )}
    </div>
  );
}
