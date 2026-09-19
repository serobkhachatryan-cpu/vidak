import { expect, test } from '@playwright/test';
import { expectNoVerifiedNameOverlay, signInTo } from './helpers';

const ownedDraft = {
  id: 'owned-draft-e2e',
  channelId: 'channel-e2e',
  title: 'Cut in progress',
  description: '',
  thumbnailUrl: '',
  durationSeconds: 24,
  status: 'draft',
  visibility: 'private',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: [],
};

const ownedPublic = {
  id: 'owned-public-e2e',
  channelId: 'channel-e2e',
  title: 'Published update',
  description: '',
  thumbnailUrl: '',
  durationSeconds: 55,
  status: 'published',
  visibility: 'public',
  publicVideoId: 'published-update-e2e',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: [],
};

const ownedUnlisted = {
  id: 'owned-unlisted-e2e',
  channelId: 'channel-e2e',
  title: 'Link-only briefing',
  description: '',
  thumbnailUrl: '',
  durationSeconds: 35,
  status: 'published',
  visibility: 'unlisted',
  publicVideoId: 'link-only-briefing-e2e',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: [],
};

const ownedPrivate = {
  id: 'owned-private-e2e',
  channelId: 'channel-e2e',
  title: 'Private source cut',
  description: '',
  thumbnailUrl: '',
  durationSeconds: 41,
  status: 'published',
  visibility: 'private',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: [],
};

const personalW3dsVideo = {
  id: 'personal-w3ds-e2e',
  title: 'A video from another W3DS app',
  accessScope: 'personal',
  visibility: 'private',
  kind: 'file',
  streamIds: ['personal-w3ds-stream'],
  previewState: 'unavailable',
};

const sharedW3dsVideo = {
  id: 'shared-w3ds-e2e',
  title: 'A video Ada shared',
  accessScope: 'shared',
  visibility: 'shared-with-me',
  kind: 'video-message',
  sharedBy: 'Ada Lovelace',
  sharedVia: 'conversation',
  streamIds: ['shared-w3ds-stream'],
  previewState: 'unavailable',
};

const checkingSharedW3dsVideo = {
  id: 'checking-shared-w3ds-e2e',
  title: 'A video while access is checked',
  accessScope: 'shared',
  visibility: 'shared-with-me',
  kind: 'file',
  sourceAccess: 'checking',
  previewState: 'unavailable',
};

function libraryResponse() {
  return {
    items: [personalW3dsVideo, sharedW3dsVideo, checkingSharedW3dsVideo],
    conversations: [],
    messages: [],
    completeness: {
      indexed: 2,
      expected: 2,
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
      sourceCounts: { personalPages: 1, sharedSpaces: 1, failed: 0 },
    },
  };
}

const privatePolicyResponse = {
  audience: 'private',
  readerENames: [],
  groupENames: [],
  w3dsAcl: {
    v: 1,
    grants: [{ ename: '@library-viewer.w3id', perms: 15 }],
    denials: { enames: [], conditions: [] },
    default_perms: 0,
    require: [],
  },
  enforcement: {
    vidakHostedMedia: 'active',
    eVaultRecordAcl: 'not_configured',
  },
  video: {
    id: ownedPrivate.id,
    title: ownedPrivate.title,
    status: 'published',
    visibility: 'private',
  },
};

const linkOnlyPolicyResponse = {
  audience: 'unlisted',
  readerENames: [],
  groupENames: [],
  watchUrl: `/watch/${ownedUnlisted.publicVideoId}`,
  w3dsAcl: {
    v: 1,
    grants: [{ ename: '@library-viewer.w3id', perms: 15 }],
    denials: { enames: [], conditions: [] },
    default_perms: 1,
    require: [[]],
  },
  enforcement: {
    vidakHostedMedia: 'active',
    eVaultRecordAcl: 'not_configured',
  },
  video: {
    id: ownedUnlisted.id,
    title: ownedUnlisted.title,
    status: 'published',
    visibility: 'unlisted',
    publicVideoId: ownedUnlisted.publicVideoId,
  },
};

const legacyGroupPolicyResponse = {
  audience: 'groups',
  readerENames: [],
  groupENames: ['@reviewers.w3id'],
  w3dsAcl: {
    v: 1,
    grants: [
      { ename: '@library-viewer.w3id', perms: 15 },
      { ename: '@reviewers.w3id', perms: 1 },
    ],
    denials: { enames: [], conditions: [] },
    default_perms: 0,
    require: [],
  },
  enforcement: {
    vidakHostedMedia: 'active',
    eVaultRecordAcl: 'not_configured',
  },
  video: {
    id: ownedPrivate.id,
    title: ownedPrivate.title,
    status: 'published',
    visibility: 'private',
  },
};

test('library destinations and card actions stay clear across ownership boundaries', async ({
  page,
}) => {
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
      body: JSON.stringify({ items: [ownedDraft, ownedPublic, ownedUnlisted, ownedPrivate] }),
    });
  });
  await page.route('**/api/videos/public**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route('**/api/videos/owned-private-e2e/sharing', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(privatePolicyResponse),
    });
  });
  await page.route('**/api/videos/owned-unlisted-e2e/sharing', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(linkOnlyPolicyResponse),
    });
  });
  await page.route('**/api/videos/owned/**/preview', async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'processing' }),
    });
  });

  await signInTo(page, '@library-viewer.w3id', '/');
  await expectNoVerifiedNameOverlay(page);

  await expect(page.getByRole('heading', { name: 'All accessible videos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My videos', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shared with me', exact: true })).toBeVisible();
  await expect(
    page.getByText('Every card explains why it is here and what you can do with it.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find my videos' })).toHaveCount(0);

  const draftCard = page.locator('article').filter({ hasText: 'Cut in progress' });
  await expect(draftCard.getByText('You own this draft')).toBeVisible();
  await expect(draftCard.getByRole('button', { name: 'Continue editing' })).toBeVisible();
  await expect(draftCard.getByRole('button', { name: 'Manage access' })).toBeVisible();
  await expect(
    draftCard.getByRole('link', { name: 'Continue editing: Cut in progress' }),
  ).toHaveCount(2);
  await expect(
    draftCard.getByRole('link', { name: 'Continue editing: Cut in progress' }).first(),
  ).toHaveAttribute('href', '/upload?draft=owned-draft-e2e');

  const publishedCard = page.locator('article').filter({ hasText: 'Published update' });
  await expect(publishedCard.getByText('You own this Vidak video')).toBeVisible();
  await expect(publishedCard.getByRole('button', { name: 'Watch video' })).toBeVisible();
  await expect(publishedCard.getByRole('button', { name: 'Manage access' })).toBeVisible();
  await expect(
    publishedCard.getByRole('link', { name: 'Watch video: Published update' }).first(),
  ).toHaveAttribute('href', '/watch/published-update-e2e');

  const linkOnlyCard = page.locator('article').filter({ hasText: 'Link-only briefing' });
  await expect(linkOnlyCard.getByText('You own this Vidak video')).toBeVisible();
  await expect(linkOnlyCard.getByText('Link only')).toBeVisible();
  await expect(linkOnlyCard.getByText(/anyone with the link can watch/i)).toBeVisible();
  await expect(linkOnlyCard.getByRole('button', { name: 'Watch video' })).toBeVisible();
  await expect(linkOnlyCard.getByRole('button', { name: 'Manage access' })).toBeVisible();
  await expect(
    linkOnlyCard.getByRole('link', { name: 'Watch video: Link-only briefing' }).first(),
  ).toHaveAttribute('href', '/watch/link-only-briefing-e2e');

  const privateCard = page.locator('article').filter({ hasText: 'Private source cut' });
  await expect(privateCard.getByText(/not in the public catalogue/i)).toBeVisible();
  await expect(privateCard.getByRole('button', { name: 'Manage access' })).toBeVisible();
  await expect(privateCard.getByRole('button', { name: 'Watch video' })).toHaveCount(0);
  await expect(
    privateCard.getByRole('link', { name: 'Manage access: Private source cut' }).first(),
  ).toHaveAttribute('href', '/videos/owned-private-e2e/sharing');

  const personalCard = page.locator('article').filter({ hasText: 'A video from another W3DS app' });
  await expect(personalCard.getByText('Your W3DS video')).toBeVisible();
  await expect(personalCard.getByRole('button', { name: 'Watch video' })).toBeVisible();
  await expect(personalCard.getByRole('button', { name: 'Manage access' })).toHaveCount(0);
  await expect(personalCard.getByText(/sharing policy stays managed by the app/i)).toBeVisible();

  const sharedCard = page.locator('article').filter({ hasText: 'A video Ada shared' });
  await expect(sharedCard.getByText('Shared by Ada Lovelace')).toBeVisible();
  await expect(sharedCard.getByText(/view only/i)).toBeVisible();
  await expect(sharedCard.getByRole('button', { name: 'Watch video' })).toBeVisible();
  await expect(sharedCard.getByRole('button', { name: 'Manage access' })).toHaveCount(0);

  const checkingCard = page
    .locator('article')
    .filter({ hasText: 'A video while access is checked' });
  await expect(checkingCard.getByText('Checking access')).toBeVisible();
  await expect(checkingCard.getByRole('button', { name: 'Watch video' })).toHaveCount(0);
  await expect(checkingCard.getByRole('button', { name: 'Manage access' })).toHaveCount(0);

  await page.getByRole('button', { name: 'My videos' }).click();
  await expect(page).toHaveURL(/\/?tab=yours$/);
  await expect(page.getByRole('link', { name: 'My videos' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { name: 'A video Ada shared' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Shared with me' }).click();
  await expect(page).toHaveURL(/\/?tab=shared$/);
  await expect(page.getByRole('link', { name: 'Shared with me' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { name: 'Cut in progress' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A video Ada shared' })).toBeVisible();

  await page.getByRole('button', { name: 'Public catalogue' }).click();
  await expect(page).toHaveURL(/\/?tab=explore$/);
  await expect(page.getByRole('heading', { name: 'Public catalogue' })).toBeVisible();
  await expect(page.getByText(/link-only and private videos are not listed here/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh your video space' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh public catalogue' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/?tab=yours$/);
  await expect(page.getByRole('heading', { name: 'Cut in progress' })).toBeVisible();

  await linkOnlyCard.getByRole('button', { name: 'Manage access' }).click();
  await expect(page).toHaveURL(/\/videos\/owned-unlisted-e2e\/sharing$/);
  await expect(
    page.getByRole('heading', { name: 'Manage access: Link-only briefing' }),
  ).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Anyone with the link' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Copy link-only watch link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open link-only player' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/?tab=yours$/);

  await privateCard.getByRole('button', { name: 'Manage access' }).click();
  await expect(page).toHaveURL(/\/videos\/owned-private-e2e\/sharing$/);
  await expect(
    page.getByRole('heading', { name: 'Manage access: Private source cut' }),
  ).toBeVisible();
  const unpublishButton = page.getByRole('button', { name: 'Unpublish and return to draft' });
  await expect(unpublishButton).toBeDisabled();
  await expect(
    page.getByText(/if you publish again without changing it, that audience resumes/i),
  ).toBeVisible();
  await page
    .getByRole('checkbox', {
      name: 'I understand that this stops playback now and keeps the current access choice for a later republish.',
    })
    .check();
  await expect(unpublishButton).toBeEnabled();
});

test('a shared-video title starts the same authorization warmup as Watch', async ({ page }) => {
  let authorizationRequests = 0;
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
  await page.route('**/api/evault/videos/shared-w3ds-stream/authorize', async (route) => {
    authorizationRequests += 1;
    await route.fulfill({ status: 204 });
  });

  await signInTo(page, '@title-warmup-viewer.w3id', '/');
  const sharedCard = page.locator('article').filter({ hasText: 'A video Ada shared' });
  const titleLink = sharedCard
    .getByRole('link', { name: 'Watch video: A video Ada shared' })
    .last();
  await expect(titleLink).toBeVisible();

  const authorizationRequest = page.waitForRequest((request) =>
    request.url().endsWith('/api/evault/videos/shared-w3ds-stream/authorize'),
  );
  await titleLink.click();
  await authorizationRequest;
  await expect.poll(() => authorizationRequests).toBe(1);
  await expect(page).toHaveURL(/\/watch\/space\/shared-w3ds-e2e$/);
});

test('a legacy group policy is visible and cannot be silently replaced', async ({ page }) => {
  await page.route('**/api/videos/owned-private-e2e/sharing', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(legacyGroupPolicyResponse),
    });
  });

  await signInTo(page, '@library-viewer.w3id', '/videos/owned-private-e2e/sharing');
  await expect(page.getByText('This video has a legacy group access policy stored.')).toBeVisible();
  const saveButton = page.getByRole('button', { name: 'Save access settings' });
  await expect(saveButton).toBeDisabled();
  await page.getByRole('radio', { name: 'Only me' }).check();
  await expect(saveButton).toBeEnabled();
});

test('a failed owned-video request is not presented as an empty library', async ({ page }) => {
  await page.route(/\/api\/evault\/videos(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...libraryResponse(), items: [] }),
    });
  });
  await page.route('**/api/videos/mine**', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Owned videos are unavailable.' } }),
    });
  });

  await signInTo(page, '@library-viewer.w3id', '/?tab=yours');
  await expect(
    page.getByRole('heading', { name: 'Could not load your Vidak videos' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No videos you own yet' })).toHaveCount(0);
});
