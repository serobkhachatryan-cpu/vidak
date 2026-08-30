import { expect, type Route, test } from '@playwright/test';
import { expectNoVerifiedNameOverlay, signInTo } from './helpers';

async function signInAndOpenUpload(page: Parameters<typeof signInTo>[0], eName: string) {
  await signInTo(page, eName, '/upload');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expectNoVerifiedNameOverlay(page);
}

function tinyMp4(): Buffer {
  // Minimal non-empty payload accepted by the browser file input (type video/mp4).
  return Buffer.from('e2e-tiny-video-bytes');
}

/**
 * Authenticated eID session → select a small video → draft is persisted → media upload.
 * Draft/media HTTP is route-mocked so the suite stays free of DATABASE_URL while still
 * exercising the real W3DS client path and upload-page state machine.
 */
test('authenticated upload persists a draft once then uploads media', async ({ page }) => {
  const draftId = 'e2e-draft-1';
  const createBodies: unknown[] = [];
  const mediaCalls: string[] = [];

  await signInAndOpenUpload(page, '@uploader.w3id');

  await page.route('**/api/videos/**', async (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    if (pathname === '/api/videos/drafts' && request.method() === 'POST') {
      const raw = request.postData();
      createBodies.push(raw ? JSON.parse(raw) : {});
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: draftId,
          channelId: 'channel-e2e',
          title: 'E2e Clip',
          description: '',
          thumbnailUrl: '',
          durationSeconds: 0,
          status: 'draft',
          visibility: 'private',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          viewCount: 0,
          likeCount: 0,
          commentCount: 0,
          tags: [],
        }),
      });
      return;
    }

    if (pathname === `/api/videos/drafts/${draftId}/media` && request.method() === 'POST') {
      mediaCalls.push(request.url());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'asset-e2e-1',
          ownerId: 'user-e2e',
          videoId: draftId,
          originalFilename: 'e2e-clip.mp4',
          contentType: 'video/mp4',
          byteSize: tinyMp4().byteLength,
          uploadState: 'ready',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }

    await route.fallback();
  });

  await page.locator('input[type="file"][accept*="video"]').setInputFiles({
    name: 'e2e-clip.mp4',
    mimeType: 'video/mp4',
    buffer: tinyMp4(),
  });

  await expect.poll(() => createBodies.length, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => mediaCalls.length).toBe(1);
  expect(createBodies[0]).toMatchObject({ title: 'E2e Clip' });
  expect(mediaCalls[0]).toContain(`/api/videos/drafts/${draftId}/media`);

  await expect(page.getByRole('heading', { name: /^Details$/i })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('E2e Clip');
});

test('draft save failure keeps the file and does not call media upload', async ({ page }) => {
  let mediaCalls = 0;

  await signInAndOpenUpload(page, '@draftfail.w3id');

  await page.route('**/api/videos/drafts', async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname !== '/api/videos/drafts' || route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'internal_error', message: 'Video drafts are unavailable.' },
      }),
    });
  });

  await page.route('**/api/videos/drafts/**/media', async (route: Route) => {
    if (route.request().method() === 'POST') {
      mediaCalls += 1;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal_error', message: 'should not upload' } }),
    });
  });

  await page.locator('input[type="file"][accept*="video"]').setInputFiles({
    name: 'pending-clip.mp4',
    mimeType: 'video/mp4',
    buffer: tinyMp4(),
  });

  await expect(page.getByText('Could not save draft')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry saving draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete draft details' })).toBeVisible();
  expect(mediaCalls).toBe(0);

  await page.getByRole('button', { name: 'Complete draft details' }).click();
  await expect(page.getByText(/Selected: pending-clip\.mp4/i)).toBeVisible();
  await expect(page.getByText(/save your draft before uploading/i)).toBeVisible();
  expect(mediaCalls).toBe(0);
});
