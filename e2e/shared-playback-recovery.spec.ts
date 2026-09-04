import { expect, test } from '@playwright/test';
import { expectNoVerifiedNameOverlay, pathnameOf, signInTo } from './helpers';

const sharedVideo = {
  id: 'shared-playback-e2e',
  title: 'Authorized shared recording',
  accessScope: 'shared',
  visibility: 'shared-with-me',
  kind: 'file',
  durationSeconds: 42,
  createdAt: '2026-09-01T00:00:00.000Z',
  streamIds: ['shared-playback-stream'],
  previewState: 'unavailable',
};

function libraryResponse() {
  return {
    items: [sharedVideo],
    conversations: [],
    messages: [],
    completeness: {
      indexed: 1,
      expected: 1,
      denied: 0,
      missing: 0,
      complete: true,
      retryNeeded: false,
      retryUnavailable: 0,
      retryRejected: 0,
      retryRateLimited: 0,
    },
    discovery: 'complete',
    scope: 'all',
    metrics: {
      cache: 'hit',
      firstResultMs: 0,
      sourceCounts: { personalPages: 0, sharedSpaces: 1, failed: 0 },
    },
  };
}

test('an authorized shared card opens its private player and offers a bounded retry', async ({
  page,
}) => {
  let playbackRequests = 0;
  await page.route(/\/api\/evault\/videos(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(libraryResponse()),
    });
  });
  await page.route('**/api/videos/mine**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route('**/api/evault/videos/shared-playback-stream?*', async (route) => {
    playbackRequests += 1;
    // A browser-level source failure must expose one deliberate retry, rather
    // than hiding an authorized shared card or looping indefinitely.
    await route.abort('failed');
  });

  await signInTo(page, '@shared-viewer.w3id', '/');
  await expectNoVerifiedNameOverlay(page);
  await page.getByRole('button', { name: 'Shared with me' }).click();
  await expect(page.getByRole('heading', { name: 'Authorized shared recording' })).toBeVisible();
  await page.getByRole('button', { name: 'Watch video' }).click();

  await expect.poll(() => pathnameOf(page.url())).toBe('/watch/space/shared-playback-e2e');
  const player = page.locator('video[aria-label="Authorized shared recording"]');
  await expect(player).toHaveAttribute(
    'src',
    /\/api\/evault\/videos\/shared-playback-stream\?attempt=0$/,
  );
  await expect(page.getByText('Video source is unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry playback' })).toBeVisible();

  await page.getByRole('button', { name: 'Retry playback' }).click();
  await expect.poll(() => playbackRequests).toBeGreaterThanOrEqual(2);
  await expect(player).toHaveAttribute(
    'src',
    /\/api\/evault\/videos\/shared-playback-stream\?attempt=1$/,
  );
});
