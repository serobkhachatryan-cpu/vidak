import { expect, test } from '@playwright/test';
import { expectNoVerifiedNameOverlay, pathnameOf, signInTo } from './helpers';

test('auth and upload stay free of a verified-name overlay', async ({ page }) => {
  await signInTo(page, '@overlay.w3id', '/upload');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expectNoVerifiedNameOverlay(page);

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect.poll(() => pathnameOf(page.url())).toBe('/');
  await expectNoVerifiedNameOverlay(page);

  // Home also has an in-page Upload CTA; exercise the header control that the overlay used to intercept.
  await page.getByRole('banner').getByRole('button', { name: 'Upload', exact: true }).click();
  await expect.poll(() => pathnameOf(page.url())).toBe('/upload');
  await expectNoVerifiedNameOverlay(page);
  await expect(page.locator('input[type="file"][accept*="video"]')).toBeVisible();
});

test('verified-name import is an explicit Profile action', async ({ page }) => {
  await page.route('**/api/auth/verified-full-name', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          eligible: true,
          prompt: true,
          sourceReady: true,
          decision: null,
          reason: 'ready',
        }),
      });
      return;
    }
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as { grant?: boolean };
      expect(body.grant).toBe(true);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { displayName: 'Ada Lovelace', profile: { displayName: 'Ada Lovelace' } },
        }),
      });
      return;
    }
    await route.fallback();
  });

  await signInTo(page, '@profile-name.w3id', '/settings');
  await expect.poll(() => pathnameOf(page.url())).toBe('/settings');
  await expectNoVerifiedNameOverlay(page);

  const headerCta = page.getByRole('link', { name: 'Use verified name from eID' });
  await expect(headerCta).toBeVisible();
  await expect(headerCta).toHaveAttribute('href', '/settings?section=profile');

  await page.goto('/settings?section=profile');
  await expectNoVerifiedNameOverlay(page);
  const profileAction = page.getByRole('button', { name: 'Use verified name from eID' });
  await expect(profileAction).toBeVisible();
  await expect(page.getByText(/will not overwrite a name you already chose/i)).toBeVisible();

  await profileAction.click();
  await expect(page.getByRole('button', { name: 'Ada Lovelace' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Use verified name from eID' })).toHaveCount(0);
  await expectNoVerifiedNameOverlay(page);
});

test('Profile keeps identity-binding failure states without blocking the app', async ({ page }) => {
  await page.route('**/api/auth/verified-full-name', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'authorization_denied',
            message: 'Vidak is not allowed to read the verified name.',
            reason: 'authorization_denied',
          },
        }),
      });
      return;
    }
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'name_not_replaceable',
            message: 'Your public name was already set and was not changed.',
            reason: 'name_not_replaceable',
          },
        }),
      });
      return;
    }
    await route.fallback();
  });

  await signInTo(page, '@name-denied.w3id', '/');
  await expectNoVerifiedNameOverlay(page);
  await page.goto('/settings?section=profile');
  await expect(page.getByRole('button', { name: 'Use verified name from eID' })).toBeVisible();
  await expect(page.getByText(/not allowed to read the verified name/i)).toBeVisible();
  await expect(page.getByText(/authorization_denied/i)).toBeVisible();

  await page.getByRole('button', { name: 'Use verified name from eID' }).click();
  await expect(page.getByText(/already set and was not changed/i)).toBeVisible();
  await expectNoVerifiedNameOverlay(page);

  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect.poll(() => pathnameOf(page.url())).toBe('/upload');
  await expectNoVerifiedNameOverlay(page);
});
