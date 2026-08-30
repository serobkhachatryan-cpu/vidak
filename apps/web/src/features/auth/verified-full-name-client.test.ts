import { describe, expect, it, vi } from 'vitest';
import {
  fetchVerifiedFullNameConsent,
  messageForVerifiedFullNameStatus,
  shouldCheckVerifiedFullName,
  submitVerifiedFullNameGrant,
  verifiedFullNameUiFromGet,
} from './verified-full-name-client';

describe('shouldCheckVerifiedFullName', () => {
  it('uses the authenticated session provider, not the build-time client provider', () => {
    expect(shouldCheckVerifiedFullName({ sessionProvider: 'w3ds', hasUser: true })).toBe(true);
    expect(shouldCheckVerifiedFullName({ sessionProvider: 'dev', hasUser: true })).toBe(false);
    expect(shouldCheckVerifiedFullName({ sessionProvider: 'w3ds', hasUser: false })).toBe(false);
  });
});

describe('messageForVerifiedFullNameStatus', () => {
  it('does not map configuration, ACL, or parse failures to a missing-name message', () => {
    expect(messageForVerifiedFullNameStatus(404, 'name_unavailable')).toBe(
      'No verified name is stored with your eID yet.',
    );
    expect(messageForVerifiedFullNameStatus(403, 'authorization_denied')).toBe(
      'Vidak is not allowed to read the verified name.',
    );
    expect(messageForVerifiedFullNameStatus(502, 'parse_failure')).toBe(
      'The verified name could not be read from your eID.',
    );
    expect(messageForVerifiedFullNameStatus(503, 'remote_unavailable', 'source_unavailable')).toBe(
      'Your verified name is not available right now.',
    );
  });
});

describe('verifiedFullNameUiFromGet', () => {
  it('does not swallow a failed status as ineligible', () => {
    expect(verifiedFullNameUiFromGet({ ok: false, status: 401 })).toMatchObject({
      kind: 'unavailable',
      message: 'Your sign-in needs to be refreshed before the verified name can be used.',
    });
    expect(verifiedFullNameUiFromGet({ ok: false, status: 503 })).toMatchObject({
      kind: 'unavailable',
      message: 'Your verified name is not available right now.',
    });
  });

  it('prompts on first eligibility and keeps a declined name available for Profile', () => {
    expect(
      verifiedFullNameUiFromGet({
        ok: true,
        status: 200,
        body: { eligible: true, prompt: true, sourceReady: true, decision: null, reason: 'ready' },
      }),
    ).toMatchObject({ kind: 'prompt' });
    expect(
      verifiedFullNameUiFromGet({
        ok: true,
        status: 200,
        body: { eligible: true, prompt: false, sourceReady: true, decision: 'declined' },
      }),
    ).toMatchObject({ kind: 'profile' });
  });

  it('surfaces an unready name source instead of hiding the choice', () => {
    expect(
      verifiedFullNameUiFromGet({
        ok: true,
        status: 200,
        body: { eligible: false, prompt: false, sourceReady: false, decision: null },
      }),
    ).toMatchObject({
      kind: 'unavailable',
      message: 'Your verified name is not available right now.',
      reason: 'source_unconfigured',
    });
  });
});

describe('fetchVerifiedFullNameConsent', () => {
  it('retries once after refreshing an expired session', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/refresh')) {
        return new Response('{}', { status: 200 });
      }
      if (
        fetcher.mock.calls.filter((call) => String(call[0]).includes('verified-full-name'))
          .length <= 1
      ) {
        return new Response(JSON.stringify({ error: { code: 'invalid_session' } }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({
          eligible: true,
          prompt: true,
          sourceReady: true,
          decision: null,
          reason: 'ready',
        }),
        { status: 200 },
      );
    });
    await expect(fetchVerifiedFullNameConsent(fetcher as typeof fetch)).resolves.toMatchObject({
      kind: 'prompt',
    });
    expect(fetcher).toHaveBeenCalledWith('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
  });
});

describe('submitVerifiedFullNameGrant', () => {
  it('returns a diagnostic reason so Try again can re-run the lookup', async () => {
    const fetcher = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 'authorization_denied', reason: 'authorization_denied' },
        }),
        { status: 403 },
      );
    });
    await expect(submitVerifiedFullNameGrant(true, fetcher as typeof fetch)).resolves.toEqual({
      ok: false,
      message: 'Vidak is not allowed to read the verified name.',
      reason: 'authorization_denied',
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/auth/verified-full-name',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('shouldCheckVerifiedFullName', () => {
  it('uses the authenticated session provider, not the build-time client provider', () => {
    expect(shouldCheckVerifiedFullName({ sessionProvider: 'w3ds', hasUser: true })).toBe(true);
    expect(shouldCheckVerifiedFullName({ sessionProvider: 'dev', hasUser: true })).toBe(false);
    expect(shouldCheckVerifiedFullName({ sessionProvider: 'w3ds', hasUser: false })).toBe(false);
  });
});

describe('verifiedFullNameUiFromGet', () => {
  it('does not swallow a failed status as ineligible', () => {
    expect(verifiedFullNameUiFromGet({ ok: false, status: 401 })).toMatchObject({
      kind: 'unavailable',
      message: 'Your sign-in needs to be refreshed before the verified name can be used.',
    });
    expect(verifiedFullNameUiFromGet({ ok: false, status: 503 })).toMatchObject({
      kind: 'unavailable',
      message: 'Your verified name is not available right now.',
    });
  });

  it('prompts on first eligibility and keeps a declined name available for Profile', () => {
    expect(
      verifiedFullNameUiFromGet({
        ok: true,
        status: 200,
        body: { eligible: true, prompt: true, sourceReady: true, decision: null },
      }),
    ).toMatchObject({ kind: 'prompt' });
    expect(
      verifiedFullNameUiFromGet({
        ok: true,
        status: 200,
        body: { eligible: true, prompt: false, sourceReady: true, decision: 'declined' },
      }),
    ).toMatchObject({ kind: 'profile' });
  });

  it('surfaces an unready name source instead of hiding the choice', () => {
    expect(
      verifiedFullNameUiFromGet({
        ok: true,
        status: 200,
        body: { eligible: false, prompt: false, sourceReady: false, decision: null },
      }),
    ).toMatchObject({
      kind: 'unavailable',
      message: 'Your verified name is not available right now.',
    });
  });
});

describe('fetchVerifiedFullNameConsent', () => {
  it('retries once after refreshing an expired session', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/refresh')) {
        return new Response('{}', { status: 200 });
      }
      if (
        fetcher.mock.calls.filter((call) => String(call[0]).includes('verified-full-name'))
          .length <= 1
      ) {
        return new Response(JSON.stringify({ error: { code: 'invalid_session' } }), {
          status: 401,
        });
      }
      return new Response(
        JSON.stringify({ eligible: true, prompt: true, sourceReady: true, decision: null }),
        { status: 200 },
      );
    });
    await expect(fetchVerifiedFullNameConsent(fetcher as typeof fetch)).resolves.toMatchObject({
      kind: 'prompt',
    });
    expect(fetcher).toHaveBeenCalledWith('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
  });
});
