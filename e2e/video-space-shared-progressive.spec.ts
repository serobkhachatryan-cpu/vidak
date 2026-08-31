import { expect, test } from '@playwright/test';
import { expectNoVerifiedNameOverlay, signInTo } from './helpers';

test('Shared with you grows from partial results to complete without a refresh', async ({
  page,
}) => {
  let sharedCalls = 0;
  let ownedCalls = 0;
  await page.route('**/api/evault/videos**', async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get('scope') ?? 'owned';
    if (scope === 'shared') {
      sharedCalls += 1;
      const refreshing = sharedCalls < 3;
      const items =
        sharedCalls === 1
          ? [
              {
                id: 'shared-e2e-1',
                title: 'First authorised clip',
                accessScope: 'shared',
                visibility: 'shared-with-me',
                kind: 'file',
                streamIds: ['e2e-stream-1'],
                previewState: 'processing',
              },
            ]
          : [
              {
                id: 'shared-e2e-1',
                title: 'First authorised clip',
                accessScope: 'shared',
                visibility: 'shared-with-me',
                kind: 'file',
                streamIds: ['e2e-stream-1'],
                previewState: 'processing',
              },
              {
                id: 'shared-e2e-2',
                title: 'Second authorised clip',
                accessScope: 'shared',
                visibility: 'shared-with-me',
                kind: 'file',
                streamIds: ['e2e-stream-2'],
                previewState: 'processing',
              },
            ];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          conversations: [],
          messages: [],
          completeness: {
            indexed: refreshing ? 1 : 2,
            expected: 2,
            denied: 0,
            missing: 0,
            complete: !refreshing,
            retryNeeded: false,
            retryUnavailable: 0,
            retryRejected: 0,
            retryRateLimited: 0,
            retrying: refreshing ? 1 : 0,
          },
          discovery: refreshing ? 'refreshing' : 'complete',
          scope: 'shared',
          metrics: {
            cache: sharedCalls === 1 ? 'miss' : 'coalesced',
            firstResultMs: 8,
            sourceCounts: { personalPages: 1, sharedSpaces: items.length, failed: 0 },
          },
        }),
      });
      return;
    }
    ownedCalls += 1;
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
          retrying: 0,
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
  await expect(page.getByRole('heading', { name: 'Personal studio take' })).toBeVisible();
  expect(sharedCalls).toBe(0);
  expect(ownedCalls).toBeGreaterThan(0);
  await expect(page.getByText('Finding video you can access')).toHaveCount(0);

  const sharedStarted = Date.now();
  await page.getByRole('button', { name: 'Shared with you' }).click();
  await expect(page.getByRole('heading', { name: 'Shared with you' })).toBeVisible({
    timeout: 2000,
  });
  expect(Date.now() - sharedStarted).toBeLessThan(2000);
  await expect(page.getByRole('button', { name: 'Shared with you' })).toBeEnabled();
  await expect(page.getByText(/shared videos found/i)).toBeVisible();
  await expect(page.getByText('Finding video you can access')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'First authorised clip' })).toBeVisible({
    timeout: 4000,
  });
  await expect(page.getByRole('heading', { name: 'Second authorised clip' })).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByRole('button', { name: 'Refresh your video space' })).toBeEnabled();
});

test('Your videos stays on owned inventory without opening Shared with you', async ({ page }) => {
  let sharedCalls = 0;
  await page.route('**/api/evault/videos**', async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get('scope') ?? 'owned';
    if (scope === 'shared') {
      sharedCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [],
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
            retrying: 0,
          },
          discovery: 'complete',
          scope: 'shared',
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
            id: 'owned-only',
            title: 'Only mine',
            accessScope: 'personal',
            visibility: 'private',
            kind: 'file',
            streamIds: ['owned-only-stream'],
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
          retrying: 0,
        },
        discovery: 'complete',
        scope: 'owned',
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

  await signInTo(page, '@owner.w3id', '/');
  await expect(page.getByRole('heading', { name: 'Only mine' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your videos' })).toBeVisible();
  expect(sharedCalls).toBe(0);
});
