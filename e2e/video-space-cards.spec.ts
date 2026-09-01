import { expect, test } from '@playwright/test';
import { expectNoVerifiedNameOverlay, signInTo } from './helpers';

const readyPoster = {
  id: 'ready-card',
  title: 'Launch recap',
  accessScope: 'personal',
  visibility: 'private',
  kind: 'file',
  durationSeconds: 95,
  createdAt: '2026-08-01T00:00:00.000Z',
  streamIds: ['ready-stream'],
  previewState: 'ready',
  previewUrl: '/api/evault/videos/ready-stream/preview',
};

const generatedPoster = {
  id: 'generated-card',
  title: 'Road update',
  accessScope: 'shared',
  visibility: 'shared-with-me',
  kind: 'video-message',
  streamIds: ['generated-stream'],
  previewState: 'processing',
  previewUrl: '/api/evault/videos/generated-stream/preview',
};

const failedPoster = {
  id: 'failed-card',
  title: 'Untitled video',
  accessScope: 'personal',
  visibility: 'private',
  kind: 'file',
  streamIds: ['failed-stream'],
  previewState: 'unavailable',
  previewUrl: '/api/evault/videos/failed-stream/preview',
};

const tinyJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=',
  'base64',
);

test('signed-in cards show authorized posters, useful titles, and compact fallbacks', async ({
  page,
}) => {
  await page.route('**/api/evault/videos/ready-stream/preview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: tinyJpeg,
    });
  });
  await page.route('**/api/evault/videos/generated-stream/preview', async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'processing' }),
    });
  });
  await page.route('**/api/evault/videos/failed-stream/preview', async (route) => {
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'unavailable' }),
    });
  });
  await page.route(/\/api\/evault\/videos(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [readyPoster, generatedPoster, failedPoster],
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
          sourceCounts: { personalPages: 1, sharedSpaces: 0, failed: 0 },
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

  await expect(page.getByRole('heading', { name: 'Launch recap' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Road update' })).toBeVisible();
  await expect(page.getByText('Shared with you')).toBeVisible();
  await expect(page.getByText('Your video', { exact: true })).toBeVisible();

  const html = await page.content();
  expect(html).not.toMatch(/w3ds:\/\//);

  await expect(
    page.locator('article img[src$="/api/evault/videos/ready-stream/preview"]'),
  ).toHaveCount(1);
  await expect(page.getByText('Preparing preview')).toHaveCount(1);
  await expect(page.getByText('Preview unavailable')).toHaveCount(1);
  const detailLines = await page
    .locator('article p.text-sm.text-muted-foreground')
    .allTextContents();
  for (const line of detailLines) {
    expect(line).not.toContain('Private');
  }

  await page.screenshot({ path: 'test-results/video-space-cards-after.png', fullPage: true });
});
