import type { AuthSession, LoginChallenge, LoginChallengeStatus } from '@w3ds/auth';

/** UI state for the W3DS “Continue with eID” login flow. */
export type W3dsLoginUiState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'pending'; challenge: LoginChallenge }
  | { kind: 'completed'; session: AuthSession }
  | { kind: 'expired'; challenge: LoginChallenge }
  | { kind: 'failed'; challenge: LoginChallenge; message: string }
  | { kind: 'error'; message: string };

export const w3dsLoginPollIntervalMs = 2_000;

export function initialW3dsLoginState(): W3dsLoginUiState {
  return { kind: 'idle' };
}

export function reduceW3dsLoginStart(): W3dsLoginUiState {
  return { kind: 'starting' };
}

export function reduceW3dsLoginChallenge(challenge: LoginChallenge): W3dsLoginUiState {
  return { kind: 'pending', challenge };
}

export function reduceW3dsLoginStartError(message: string): W3dsLoginUiState {
  return { kind: 'error', message };
}

/**
 * Maps a polled challenge status onto the login UI state.
 * Keeps the last challenge so expired/failed views can offer retry.
 */
export function reduceW3dsLoginStatus(
  challenge: LoginChallenge,
  status: LoginChallengeStatus,
): W3dsLoginUiState {
  switch (status.status) {
    case 'pending':
      return { kind: 'pending', challenge };
    case 'completed':
      return { kind: 'completed', session: status.session };
    case 'expired':
      return { kind: 'expired', challenge };
    case 'failed':
      return {
        kind: 'failed',
        challenge,
        message: status.error.message || 'Sign-in could not be verified. Please try again.',
      };
  }
}

export function reduceW3dsLoginPollError(
  challenge: LoginChallenge,
  message: string,
): W3dsLoginUiState {
  return { kind: 'failed', challenge, message };
}

export function isTerminalW3dsLoginState(state: W3dsLoginUiState): boolean {
  return (
    state.kind === 'completed' ||
    state.kind === 'expired' ||
    state.kind === 'failed' ||
    state.kind === 'error'
  );
}

export function shouldPollW3dsLoginState(state: W3dsLoginUiState): boolean {
  return state.kind === 'pending';
}

export function w3dsLoginStatusMessage(state: W3dsLoginUiState): string | undefined {
  switch (state.kind) {
    case 'starting':
      return 'Preparing a secure sign-in request…';
    case 'pending':
      return 'Waiting for approval in your eID wallet…';
    case 'expired':
      return 'This sign-in request expired. Start again to continue.';
    case 'failed':
      return state.message;
    case 'error':
      return state.message;
    default:
      return undefined;
  }
}
