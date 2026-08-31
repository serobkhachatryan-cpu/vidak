import { expect, test } from '@playwright/test';
import { expectNoVerifiedNameOverlay, signInTo } from './helpers';

test('Shared with you is interactive while inventory continues', async ({ page }) => {
  let sharedCalls = 0;
  await page.route('**/api/evault/videos**', async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get('scope') ?? 'owned';
    if (scope === 'shared') {
      sharedCalls += 1;
      const refreshing = sharedCalls < 3;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: refreshing
            ? []
            : [
                {
                  id: 'shared-e2e',
                  title: 'Authorised shared clip',
                  accessScope: 'shared',
                  visibility: 'shared-with-me',
                  kind: 'file',
                  streamIds: ['e2e-stream'],
                  previewState: 'processing',
                },
              ],
          conversations: [],
          messages: [],
          completeness: {
            indexed: refreshing ? 0 : 1,
            expected: 1,
            denied: 0,
            missing: 0,
            complete: !refreshing,
            retryNeeded: refreshing,
            retryUnavailable: 0,
            retryRejected: 0,
            retryRateLimited: 0,
          },
          discovery: refreshing ? 'refreshing' : 'complete',
          scope: 'shared',
          metrics: {
            cache: 'miss',
            firstResultMs: 8,
            sourceCounts: { personalPages: 1, sharedSpaces: refreshing ? 0 : 1, failed: 0 },
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: 'owned-e2e',
            title: 'Personal studio take',
            accessScope: 'personal',
            visibility: 'private',
            kind: 'file',
            streamIds: ['owned-stream'],
            previewState: 'processing',
          },
        ],
        conversations: [],
        messages: [],
        completeness: {
          indexed: 0,
          expected: 0,
          denied: 0,
          missing: 0,
          complete: true,
          retryNeeded: false,
          retryUnavailable: 0,
          retryRejected: 0,
          retryRateLimited: 0,
        },
        discovery: 'complete',
        scope: 'owned',
        metrics: {
          cache: 'hit',
          firstResultMs: 0,
          sourceCounts: { personalPages: 2, sharedSpaces: 0, failed: 0 },
        },
      }),
    });
  });
  await page.route('**/api/videos/mine**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });

  await signInTo(page, '@viewer.w3id', '/');
  await expectNoVerifiedNameOverlay(page);
  await expect(page.getByRole('heading', { name: 'Your videos' })).toBeVisible();
  await expect(page.getByText('Finding video you can access')).toHaveCount(0);

  const sharedStarted = Date.now();
  await page.getByRole('button', { name: 'Shared with you' }).click();
  await expect(page.getByRole('heading', { name: 'Shared with you' })).toBeVisible({
    timeout: 2000,
  });
  expect(Date.now() - sharedStarted).toBeLessThan(2000);
  await expect(page.getByRole('button', { name: 'Shared with you' })).toBeEnabled();
  await expect(page.getByText(/updating your library/i)).toBeVisible();
  await expect(page.getByText('Finding video you can access')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Authorised shared clip' })).toBeVisible({
    timeout: 8000,
  });
});
