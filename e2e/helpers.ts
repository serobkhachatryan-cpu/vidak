import { expect, type Page } from '@playwright/test';

export function pathnameOf(pageUrl: string): string {
  return new URL(pageUrl).pathname;
}

export async function completeOfferAs(page: Page, eName: string): Promise<{ offerId: string }> {
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
  return { offerId: offer.offerId };
}

export async function signInTo(page: Page, eName: string, returnTo: string): Promise<void> {
  const { offerId } = await completeOfferAs(page, eName);
  await page.goto(
    `/api/auth/offer/${encodeURIComponent(offerId)}/continue?returnTo=${encodeURIComponent(returnTo)}`,
  );
  await expect.poll(() => pathnameOf(page.url())).toBe(returnTo);
}

/** The verified-name import must never be a blocking application-shell dialog. */
export async function expectNoVerifiedNameOverlay(page: Page): Promise<void> {
  await expect(page.locator('[aria-labelledby="verified-full-name-title"]')).toHaveCount(0);
  await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
}
