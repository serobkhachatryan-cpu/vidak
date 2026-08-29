import { expect, test } from '@playwright/test';

function pathnameOf(pageUrl: string): string {
  return new URL(pageUrl).pathname;
}

async function completeOfferAs(
  page: import('@playwright/test').Page,
  eName: string,
): Promise<{ offerId: string }> {
  const offerResponse = await page.request.get('/api/auth/offer');
  expect(offerResponse.ok()).toBeTruthy();
  const offer = (await offerResponse.json()) as { offerId: string; sessionId: string };
  const completeResponse = await page.request.post('/api/auth', {
    data: {
      ename: eName,
      session: offer.sessionId,
      signature: 'e2e-stub-signature',
    },
  });
  expect(completeResponse.ok()).toBeTruthy();
  // Wallet POST must not establish the browser session cookie itself.
  const setCookie = completeResponse
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie');
  expect(setCookie).toEqual([]);
  return { offerId: offer.offerId };
}

async function expectAuthenticatedCookieSession(page: import('@playwright/test').Page) {
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name === 'w3ds_access')).toBe(true);

  const sessionResponse = await page.request.get('/api/auth/session');
  expect(sessionResponse.ok()).toBeTruthy();
  const session = (await sessionResponse.json()) as {
    provider: string;
    user: { displayName: string };
  };
  expect(session.provider).toBe('w3ds');
  expect(session.user.displayName).toBeTruthy();
  return session;
}

/**
 * Same-origin mocked W3DS offer completion (no wallet, registry, or secrets).
 * Playwright boots the web app with W3DS_AUTH_E2E_STUB=1.
 */
test('completed offer cookies hand off to an authenticated session', async ({ page }) => {
  const { offerId } = await completeOfferAs(page, '@ada.w3id');

  await page.goto(
    `/api/auth/offer/${encodeURIComponent(offerId)}/continue?returnTo=${encodeURIComponent('/settings')}`,
  );

  await expect.poll(() => pathnameOf(page.url())).toBe('/settings');
  const session = await expectAuthenticatedCookieSession(page);
  expect(session.user.displayName).toBe('New Vidak member');

  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Vidak member' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect.poll(() => pathnameOf(page.url())).toBe('/upload');
  await expect(page.getByRole('button', { name: 'New Vidak member' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect.poll(() => pathnameOf(page.url())).toBe('/settings');
  await expect.poll(() => pathnameOf(page.url())).not.toBe('/auth/handoff');
  await expect(page.getByRole('button', { name: 'New Vidak member' })).toBeVisible();
});

test('Return after mocked wallet approval lands authenticated on Settings then Upload', async ({
  page,
}) => {
  // Original browser starts login (offer created by the server login page).
  await page.goto('/login?returnTo=/settings');
  await expect(page.getByRole('heading', { name: /sign in with eid/i })).toBeVisible();

  const offerLink = page.getByRole('link', { name: 'Continue with eID' });
  await expect(offerLink).toBeVisible();
  await expect(offerLink).toHaveAttribute('href', /^w3ds:\/\/auth/);
  await expect(offerLink).toHaveText('Continue with eID');
  await expect(page.getByText(/w3ds:\/\//i)).toHaveCount(0);
  const signInUri = await offerLink.getAttribute('href');
  expect(signInUri).toMatch(/^w3ds:\/\/auth/);
  if (!signInUri) throw new Error('Expected eID sign-in URI');
  const offerUrl = new URL(signInUri);
  const sessionId = offerUrl.searchParams.get('session');
  expect(sessionId).toBeTruthy();
  if (!sessionId) throw new Error('Expected offer session id');

  // Wallet approves on a separate origin/context — no browser cookie.
  const walletApproval = await page.request.post('/api/auth', {
    data: {
      ename: '@return.w3id',
      session: sessionId,
      signature: 'e2e-stub-signature',
    },
  });
  expect(walletApproval.ok()).toBeTruthy();
  expect(
    walletApproval.headersArray().filter((header) => header.name.toLowerCase() === 'set-cookie'),
  ).toEqual([]);

  // User clicks Return: original browser finishes via continue → cookie → handoff.
  await expect.poll(() => pathnameOf(page.url()), { timeout: 20_000 }).toBe('/settings');
  await expectAuthenticatedCookieSession(page);
  await expect(page.getByRole('button', { name: 'New Vidak member' })).toBeVisible();
  await expect.poll(() => pathnameOf(page.url())).not.toBe('/auth/handoff');
  await expect.poll(() => pathnameOf(page.url())).not.toBe('/login');

  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect.poll(() => pathnameOf(page.url())).toBe('/upload');
  await expect(page.getByRole('button', { name: 'New Vidak member' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect.poll(() => pathnameOf(page.url())).toBe('/settings');
  await expect(page.getByRole('button', { name: 'New Vidak member' })).toBeVisible();
});

test('handoff never soft-loops on login or handoff returnTo', async ({ page }) => {
  const { offerId } = await completeOfferAs(page, '@loop.w3id');

  await page.goto(
    `/api/auth/offer/${encodeURIComponent(offerId)}/continue?returnTo=${encodeURIComponent('/auth/handoff')}`,
  );
  await expect.poll(() => pathnameOf(page.url())).toBe('/');
  await expect.poll(() => pathnameOf(page.url())).not.toBe('/auth/handoff');
  await expectAuthenticatedCookieSession(page);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('anonymous users are sent to login from guarded routes', async ({ page }) => {
  await page.goto('/upload');
  await expect.poll(() => pathnameOf(page.url())).toBe('/login');
  await expect(page.getByRole('heading', { name: /sign in with eid/i })).toBeVisible();
});
