import { expect, test } from '@playwright/test';

test('web application is reachable', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Vidak');
});
