import { createAuthUser, type LoginChallengeStatus } from '@w3ds/auth';
import { describe, expect, it } from 'vitest';
import { shouldContinueW3dsOfferPolling, w3dsOfferPollIntervalMs } from './w3ds-offer-polling';

const completed: LoginChallengeStatus = {
  status: 'completed',
  session: {
    provider: 'w3ds',
    user: createAuthUser({
      id: 'user-1',
      displayName: 'Ada',
      roles: ['creator'],
      eName: '@ada.w3id',
      eVaultId: 'evault-1',
    }),
    tokens: { expiresAt: '2026-08-04T12:20:00.000Z' },
  },
};

describe('W3DS offer polling model', () => {
  it('only schedules another request while an offer is pending', () => {
    expect(w3dsOfferPollIntervalMs).toBe(2_000);
    expect(shouldContinueW3dsOfferPolling({ status: 'pending' })).toBe(true);
    expect(shouldContinueW3dsOfferPolling(completed)).toBe(false);
    expect(shouldContinueW3dsOfferPolling({ status: 'expired' })).toBe(false);
    expect(
      shouldContinueW3dsOfferPolling({
        status: 'failed',
        error: { code: 'verification_failed', message: 'Could not verify sign-in.' },
      }),
    ).toBe(false);
  });
});
