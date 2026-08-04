import { createAuthUser } from '@w3ds/auth';
import { describe, expect, it } from 'vitest';
import {
  initialW3dsLoginState,
  isTerminalW3dsLoginState,
  reduceW3dsLoginChallenge,
  reduceW3dsLoginPollError,
  reduceW3dsLoginStart,
  reduceW3dsLoginStartError,
  reduceW3dsLoginStatus,
  shouldPollW3dsLoginState,
  w3dsLoginStatusMessage,
} from './w3ds-login-challenge';

const challenge = {
  offerId: 'offer-1',
  signInUri: 'w3ds://auth?session=abc&platform=vidak',
  expiresAt: '2026-08-04T12:05:00.000Z',
};

const session = {
  user: createAuthUser({
    id: 'user-1',
    displayName: 'Ada',
    roles: ['creator'] as const,
    eName: '@ada.w3id',
    eVaultId: 'evault-1',
  }),
  tokens: {
    expiresAt: '2026-08-04T12:20:00.000Z',
  },
  provider: 'w3ds' as const,
};

describe('W3DS login challenge state', () => {
  it('starts idle and moves through starting → pending', () => {
    expect(initialW3dsLoginState()).toEqual({ kind: 'idle' });
    expect(reduceW3dsLoginStart()).toEqual({ kind: 'starting' });
    expect(reduceW3dsLoginChallenge(challenge)).toEqual({ kind: 'pending', challenge });
    expect(shouldPollW3dsLoginState(reduceW3dsLoginChallenge(challenge))).toBe(true);
  });

  it('maps pending, completed, expired, and failed poll statuses', () => {
    expect(reduceW3dsLoginStatus(challenge, { status: 'pending' })).toEqual({
      kind: 'pending',
      challenge,
    });

    const completed = reduceW3dsLoginStatus(challenge, { status: 'completed', session });
    expect(completed).toEqual({ kind: 'completed', session });
    expect(isTerminalW3dsLoginState(completed)).toBe(true);
    expect(shouldPollW3dsLoginState(completed)).toBe(false);

    const expired = reduceW3dsLoginStatus(challenge, { status: 'expired' });
    expect(expired).toEqual({ kind: 'expired', challenge });
    expect(w3dsLoginStatusMessage(expired)).toMatch(/expired/i);

    const failed = reduceW3dsLoginStatus(challenge, {
      status: 'failed',
      error: { code: 'invalid_signature', message: 'Could not verify sign-in.' },
    });
    expect(failed).toEqual({
      kind: 'failed',
      challenge,
      message: 'Could not verify sign-in.',
    });
    expect(isTerminalW3dsLoginState(failed)).toBe(true);
  });

  it('surfaces start and poll errors for retry', () => {
    const startError = reduceW3dsLoginStartError('Offer unavailable.');
    expect(startError).toEqual({ kind: 'error', message: 'Offer unavailable.' });
    expect(w3dsLoginStatusMessage(startError)).toBe('Offer unavailable.');

    const pollError = reduceW3dsLoginPollError(challenge, 'Network failed.');
    expect(pollError).toEqual({
      kind: 'failed',
      challenge,
      message: 'Network failed.',
    });
    expect(shouldPollW3dsLoginState(pollError)).toBe(false);
  });

  it('keeps pending status copy protocol-agnostic', () => {
    const pending = reduceW3dsLoginChallenge(challenge);
    expect(w3dsLoginStatusMessage(pending)).toMatch(/eID wallet/i);
    expect(w3dsLoginStatusMessage(pending)).not.toMatch(/registry|evault|jwks|certificate/i);
  });
});
