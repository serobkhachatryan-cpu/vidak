import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuthHandoffPath } from '../../../../../../features/auth/auth-session-handoff';
import { resolvePublicOrigin } from '../../../../../../server/public-origin';
import * as w3dsAuth from '../../../../../../server/w3ds-auth';
import {
  InMemoryW3dsAuthStore,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsIdentityVerifier,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';
import { GET as handoff } from '../../../../../auth/handoff/route';
import { POST as completeOffer } from '../../../route';
import { GET as getSession } from '../../../session/route';
import { GET as continueOffer } from './route';

const verifiedIdentity: VerifiedW3dsIdentity = {
  eName: '@creator.w3id',
  eVaultId: 'evault-creator',
  eVaultUri: 'https://evault.example/creator',
};

const appOrigin = 'https://vidak.postplatforms.com';
const proxyOrigin = 'http://127.0.0.1:3910';

describe('W3DS auth offer continuation route', () => {
  afterEach(() => {
    resetW3dsAuthServiceForTests();
    vi.restoreAllMocks();
  });

  it('redirects through the configured public origin instead of the reverse proxy listener', () => {
    const request = new Request('http://localhost:3910/api/auth/offer/example/continue');

    expect(
      resolvePublicOrigin(request, {
        trustedOrigins: [appOrigin],
      }),
    ).toBe(appOrigin);
  });

  it('applies session cookies and sends the browser to the handoff verifier', async () => {
    const { offerId } = await bootstrapCompletedOffer();
    const response = await continueOffer(
      new Request(`${appOrigin}/api/auth/offer/${offerId}/continue?returnTo=/settings`),
      { params: Promise.resolve({ offerId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain(buildAuthHandoffPath('/settings'));
    expect(html).toContain('location.replace(');
    expect(html).toMatch(/content="1;url=/);

    const setCookie = response.headers.getSetCookie();
    const accessCookie = setCookie.find((value) => value.startsWith(`${w3dsAccessCookieName}=`));
    expect(accessCookie).toBeDefined();
    expect(accessCookie).toMatch(/Max-Age=([1-9]\d*)/);
    expect(accessCookie).toMatch(/HttpOnly/i);
    expect(accessCookie).toMatch(/Secure/i);
  });

  it('does not mint Secure cookies on plain HTTP reverse-proxy continuations', async () => {
    const { offerId } = await bootstrapCompletedOffer();
    const response = await continueOffer(
      new Request(`${proxyOrigin}/api/auth/offer/${offerId}/continue?returnTo=/upload`),
      { params: Promise.resolve({ offerId }) },
    );

    expect(response.status).toBe(200);
    const accessCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${w3dsAccessCookieName}=`));
    expect(accessCookie).toBeDefined();
    expect(accessCookie).toMatch(/Max-Age=([1-9]\d*)/);
    expect(accessCookie).not.toMatch(/Secure/i);
  });

  it('restores an authenticated session from cookies produced by continuation', async () => {
    const { offerId } = await bootstrapCompletedOffer();
    const continueResponse = await continueOffer(
      new Request(`${appOrigin}/api/auth/offer/${offerId}/continue?returnTo=/upload`),
      { params: Promise.resolve({ offerId }) },
    );

    const cookies = cookieHeaderFromSetCookie(continueResponse);
    expect(cookies).toContain(`${w3dsAccessCookieName}=`);

    const sessionResponse = await getSession(
      new NextRequest(`${appOrigin}/api/auth/session`, {
        headers: { Cookie: cookies },
      }),
    );

    expect(sessionResponse.status).toBe(200);
    const body = (await sessionResponse.json()) as {
      provider: string;
      user: { eName: string };
      tokens?: { accessToken?: string; refreshToken?: string; expiresAt?: string };
    };
    expect(body).toMatchObject({
      provider: 'w3ds',
      user: { eName: '@creator.w3id' },
      tokens: { expiresAt: expect.any(String) },
    });
    expect(body.tokens?.accessToken).toBeUndefined();
    expect(body.tokens?.refreshToken).toBeUndefined();
  });

  it('bridges mocked wallet POST approval through continue cookies into handoff', async () => {
    const { offerId, sessionId } = await bootstrapPendingOffer();

    const walletApproval = await completeOffer(
      new NextRequest(`${appOrigin}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://wallet.example' },
        body: JSON.stringify({
          ename: '@creator.w3id',
          session: sessionId,
          signature: 'signature',
        }),
      }),
    );
    expect(walletApproval.status).toBe(200);
    expect(walletApproval.headers.getSetCookie()).toEqual([]);
    await expect(walletApproval.json()).resolves.toEqual({ ok: true });

    const continueResponse = await continueOffer(
      new Request(`${proxyOrigin}/api/auth/offer/${offerId}/continue?returnTo=/settings`),
      { params: Promise.resolve({ offerId }) },
    );
    expect(continueResponse.status).toBe(200);
    const setCookie = continueResponse.headers.getSetCookie();
    const accessCookie = setCookie.find((value) => value.startsWith(`${w3dsAccessCookieName}=`));
    expect(accessCookie).toMatch(/Max-Age=([1-9]\d*)/);
    expect(accessCookie).not.toMatch(/Secure/i);

    const cookies = cookieHeaderFromSetCookie(continueResponse);
    const settingsHandoff = await handoff(
      new NextRequest(`${appOrigin}/auth/handoff?returnTo=/settings`, {
        headers: { Cookie: cookies },
      }),
    );
    expect(settingsHandoff.status).toBe(307);
    expect(settingsHandoff.headers.get('location')).toBe(`${appOrigin}/settings`);

    const uploadHandoff = await handoff(
      new NextRequest(`${appOrigin}/auth/handoff?returnTo=/upload`, {
        headers: { Cookie: cookies },
      }),
    );
    expect(uploadHandoff.status).toBe(307);
    expect(uploadHandoff.headers.get('location')).toBe(`${appOrigin}/upload`);
  });
});

describe('eID session handoff destinations', () => {
  it('keeps first navigation targets for settings and upload behind the handoff', () => {
    expect(buildAuthHandoffPath('/settings')).toBe('/auth/handoff?returnTo=%2Fsettings');
    expect(buildAuthHandoffPath('/upload')).toBe('/auth/handoff?returnTo=%2Fupload');
  });
});

async function bootstrapCompletedOffer() {
  const { offerId, sessionId, service } = await bootstrapPendingOffer();
  await service.completeOffer({
    w3id: '@creator.w3id',
    session: sessionId,
    signature: 'signature',
  });
  return { offerId, service };
}

async function bootstrapPendingOffer() {
  const verifier: W3dsIdentityVerifier = {
    verify: vi.fn().mockResolvedValue(verifiedIdentity),
  };
  const service = new W3dsAuthService({
    config: {
      platformName: 'vidak',
      registryBaseUrl: 'https://registry.example',
      jwtSecret: 'a development-only test secret with at least 32 characters',
    },
    store: new InMemoryW3dsAuthStore(),
    identityVerifier: verifier,
    now: () => 1_780_000_000_000,
  });
  vi.spyOn(w3dsAuth, 'getW3dsAuthService').mockReturnValue(service);

  const offer = await service.createOffer(appOrigin);
  return { offerId: offer.offerId, sessionId: offer.sessionId, service };
}

function cookieHeaderFromSetCookie(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .filter(Boolean)
    .join('; ');
}
