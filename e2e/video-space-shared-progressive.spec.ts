import { expect, test } from '@playwright/test';
import { expectNoVerifiedNameOverlay, signInTo } from './helpers';

function libraryBody(items: unknown[], discovery: 'refreshing' | 'complete', extra?: object) {
  return {
    items,
    conversations: [],
    messages: [],
    completeness: {
      indexed: discovery === 'complete' ? 2 : 1,
      expected: 2,
      denied: 0,
      missing: 0,
      complete: discovery === 'complete',
      retryNeeded: false,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
      retrying: discovery === 'refreshing' ? 1 : 0,
    },
    discovery,
    scope: 'all',
    metrics: {
      cache: 'miss',
      firstResultMs: 8,
      sourceCounts: { personalPages: 2, sharedSpaces: items.length > 1 ? 1 : 0, failed: 0 },
    },
    ...extra,
  };
}

const ownedCall = {
  id: 'owned-call-e2e',
  title: 'Call recording · 2026-08-24',
  accessScope: 'personal',
  visibility: 'private',
  kind: 'call-recording',
  streamIds: ['owned-call-stream'],
  previewState: 'processing',
};

const firstShared = {
  id: 'shared-e2e-1',
  title: 'First authorised clip',
  accessScope: 'shared',
  visibility: 'shared-with-me',
  kind: 'file',
  streamIds: ['e2e-stream-1'],
  previewState: 'processing',
};

const secondShared = {
  id: 'shared-e2e-2',
  title: 'Second authorised clip',
  accessScope: 'shared',
  visibility: 'shared-with-me',
  kind: 'file',
  streamIds: ['e2e-stream-2'],
  previewState: 'processing',
};

test('All videos grows from a partial union to the complete result without a refresh', async ({
  page,
}) => {
  let allCalls = 0;
  let otherScopeCalls = 0;
  await page.route('**/api/evault/videos**', async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get('scope') ?? 'all';
    if (scope !== 'all') {
      otherScopeCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(libraryBody([], 'complete', { scope })),
      });
      return;
    }
    allCalls += 1;
    const refreshing = allCalls < 3;
    const items = refreshing ? [ownedCall, firstShared] : [ownedCall, firstShared, secondShared];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(libraryBody(items, refreshing ? 'refreshing' : 'complete')),
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
  await expect(page.getByRole('heading', { name: 'All videos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Call recording · 2026-08-24' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'First authorised clip' })).toBeVisible({
    timeout: 4000,
  });
  expect(allCalls).toBeGreaterThan(0);
  expect(otherScopeCalls).toBe(0);
  await expect(page.getByText('Finding video you can access')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Second authorised clip' })).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByRole('heading', { name: 'Call recording · 2026-08-24' })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'First authorised clip' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Refresh your video space' })).toBeEnabled();
});

test('My videos and Shared with me filter the same complete inventory', async ({ page }) => {
  let allCalls = 0;
  let otherScopeCalls = 0;
  await page.route('**/api/evault/videos**', async (route) => {
    const url = new URL(route.request().url());
    const scope = url.searchParams.get('scope') ?? 'all';
    if (scope !== 'all') {
      otherScopeCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(libraryBody([], 'complete', { scope })),
      });
      return;
    }
    allCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(libraryBody([ownedCall, firstShared, secondShared], 'complete')),
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
  await expect(page.getByRole('heading', { name: 'All videos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Call recording · 2026-08-24' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'First authorised clip' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Second authorised clip' })).toBeVisible();
  const allCallCount = allCalls;

  await page.getByRole('button', { name: 'My videos' }).click();
  await expect(page.getByRole('heading', { name: 'My videos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Call recording · 2026-08-24' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'First authorised clip' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Second authorised clip' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Shared with me' }).click();
  await expect(page.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'First authorised clip' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Second authorised clip' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Call recording · 2026-08-24' })).toHaveCount(0);

  expect(allCalls).toBe(allCallCount);
  expect(otherScopeCalls).toBe(0);
});
