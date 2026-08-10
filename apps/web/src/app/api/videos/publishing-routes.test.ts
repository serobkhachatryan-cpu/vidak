import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as creatorVideo from '../../../server/creator-video';
import {
  CreatorVideoService,
  type CreatorVideoStore,
  InMemoryCreatorVideoStore,
  resetCreatorVideoServiceForTests,
} from '../../../server/creator-video';
import * as mediaAssetModule from '../../../server/media-asset';
import {
  InMemoryMediaAssetStore,
  LocalDiskMediaStorage,
  MediaAssetService,
  resetMediaAssetServiceForTests,
} from '../../../server/media-asset';
import * as w3dsAuth from '../../../server/w3ds-auth';
import {
  InMemoryW3dsAuthStore,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsAuthStore,
  type W3dsIdentityVerifier,
} from '../../../server/w3ds-auth';
import { POST as publishVideo } from './[videoId]/publish/route';
import { POST as unpublishVideo } from './[videoId]/unpublish/route';
import { POST as uploadMedia } from './drafts/[videoId]/media/route';
import { POST as uploadThumbnail } from './drafts/[videoId]/thumbnail/route';
import { POST as createDraft } from './drafts/route';
import { GET as getPublicMediaContent } from './public/[publicVideoId]/media/[assetId]/content/route';
import { GET as getPublicPrimaryMedia } from './public/[publicVideoId]/media/route';
import { GET as getPublicVideo } from './public/[publicVideoId]/route';
import { GET as getPublicThumbnail } from './public/[publicVideoId]/thumbnail/route';
import { GET as listPublicVideos } from './public/route';

let rootDir = '';

describe('video publishing and public discovery routes', () => {
  afterEach(async () => {
    resetMediaAssetServiceForTests();
    resetCreatorVideoServiceForTests();
    resetW3dsAuthServiceForTests();
    vi.restoreAllMocks();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = '';
    }
  });

  it('returns 401 for anonymous publish and unpublish', async () => {
    await expect(
      publishVideo(
        new NextRequest('https://vidak.example/api/videos/v1/publish', {
          method: 'POST',
          headers: { Origin: 'https://vidak.example' },
        }),
        {
          params: Promise.resolve({ videoId: 'v1' }),
        },
      ),
    ).resolves.toMatchObject({ status: 401 });

    await expect(
      unpublishVideo(
        new NextRequest('https://vidak.example/api/videos/v1/unpublish', {
          method: 'POST',
          headers: { Origin: 'https://vidak.example' },
        }),
        { params: Promise.resolve({ videoId: 'v1' }) },
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it('publishes and unpublishes an owned video with ready media', async () => {
    const ctx = await createPublishingContext();
    const draft = await createOwnedDraft(ctx, { title: 'Publish me', visibility: 'public' });
    ctx.videoStore.seedReadyMediaAsset(draft.id);

    const published = await publishVideo(
      new NextRequest(`https://vidak.example/api/videos/${draft.id}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.ownerToken}` },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(published.status).toBe(200);
    const publishedBody = (await published.json()) as {
      id: string;
      status: string;
      visibility: string;
      publicVideoId: string;
      publishedAt: string;
    };
    expect(publishedBody).toMatchObject({
      id: draft.id,
      status: 'published',
      visibility: 'public',
    });
    expect(publishedBody.publicVideoId).toMatch(/^pub_/);
    expect(publishedBody.publishedAt).toEqual(expect.any(String));
    expect(JSON.stringify(publishedBody)).not.toMatch(/storageKey|evault|jwt|session/i);

    const unpublished = await unpublishVideo(
      new NextRequest(`https://vidak.example/api/videos/${draft.id}/unpublish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.ownerToken}` },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(unpublished.status).toBe(200);
    await expect(unpublished.json()).resolves.toMatchObject({
      id: draft.id,
      status: 'draft',
      publicVideoId: publishedBody.publicVideoId,
      visibility: 'public',
    });
  });

  it('rejects publish without ready media', async () => {
    const ctx = await createPublishingContext();
    const draft = await createOwnedDraft(ctx, { title: 'No media' });

    const response = await publishVideo(
      new NextRequest(`https://vidak.example/api/videos/${draft.id}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.ownerToken}` },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'precondition_failed' },
    });
  });

  it('returns 404 when another authenticated user tries to publish or unpublish', async () => {
    const ctx = await createPublishingContext();
    const draft = await createOwnedDraft(ctx, { title: 'Owner only', visibility: 'public' });
    ctx.videoStore.seedReadyMediaAsset(draft.id);

    const viewerToken = await loginAs(ctx.authStore, ctx.videoStore, {
      eName: '@viewer.w3id',
      eVaultId: 'evault-viewer',
      eVaultUri: 'https://evault.example/viewer',
    });

    const publishAttempt = await publishVideo(
      new NextRequest(`https://vidak.example/api/videos/${draft.id}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(publishAttempt.status).toBe(404);
    await expect(publishAttempt.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    });

    await publishVideo(
      new NextRequest(`https://vidak.example/api/videos/${draft.id}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.ownerToken}` },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );

    const unpublishAttempt = await unpublishVideo(
      new NextRequest(`https://vidak.example/api/videos/${draft.id}/unpublish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(unpublishAttempt.status).toBe(404);
    await expect(unpublishAttempt.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('resolves public and unlisted published videos by publicVideoId, but not private or drafts', async () => {
    const ctx = await createPublishingContext();

    const publicDraft = await createOwnedDraft(ctx, { title: 'Public clip', visibility: 'public' });
    ctx.videoStore.seedReadyMediaAsset(publicDraft.id);
    const publicPublished = await publishOwned(ctx, publicDraft.id);

    const unlistedDraft = await createOwnedDraft(ctx, {
      title: 'Unlisted clip',
      visibility: 'unlisted',
    });
    ctx.videoStore.seedReadyMediaAsset(unlistedDraft.id);
    const unlistedPublished = await publishOwned(ctx, unlistedDraft.id);

    const privateDraft = await createOwnedDraft(ctx, {
      title: 'Private clip',
      visibility: 'private',
    });
    ctx.videoStore.seedReadyMediaAsset(privateDraft.id);
    const privatePublished = await publishOwned(ctx, privateDraft.id);

    const draftOnly = await createOwnedDraft(ctx, { title: 'Still a draft', visibility: 'public' });

    const publicDetail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${publicPublished.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: publicPublished.publicVideoId }) },
    );
    expect(publicDetail.status).toBe(200);
    await expect(publicDetail.json()).resolves.toMatchObject({
      id: publicDraft.id,
      title: 'Public clip',
      status: 'published',
      visibility: 'public',
      publicVideoId: publicPublished.publicVideoId,
    });

    const unlistedDetail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${unlistedPublished.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: unlistedPublished.publicVideoId }) },
    );
    expect(unlistedDetail.status).toBe(200);
    await expect(unlistedDetail.json()).resolves.toMatchObject({
      id: unlistedDraft.id,
      visibility: 'unlisted',
      status: 'published',
    });

    const privateDetail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${privatePublished.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: privatePublished.publicVideoId }) },
    );
    expect(privateDetail.status).toBe(404);

    const draftDetail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${draftOnly.id}`),
      { params: Promise.resolve({ publicVideoId: draftOnly.id }) },
    );
    expect(draftDetail.status).toBe(404);

    const missing = await getPublicVideo(
      new NextRequest('https://vidak.example/api/videos/public/pub_missing'),
      { params: Promise.resolve({ publicVideoId: 'pub_missing' }) },
    );
    expect(missing.status).toBe(404);
  });

  it('lists only published public videos and paginates discovery', async () => {
    const ctx = await createPublishingContext();

    const publicIds: string[] = [];
    for (const title of ['Alpha', 'Bravo', 'Charlie']) {
      const draft = await createOwnedDraft(ctx, { title, visibility: 'public' });
      ctx.videoStore.seedReadyMediaAsset(draft.id);
      const published = await publishOwned(ctx, draft.id);
      publicIds.push(published.publicVideoId);
    }

    const unlisted = await createOwnedDraft(ctx, { title: 'Hidden link', visibility: 'unlisted' });
    ctx.videoStore.seedReadyMediaAsset(unlisted.id);
    const unlistedPublished = await publishOwned(ctx, unlisted.id);

    const privateDraft = await createOwnedDraft(ctx, {
      title: 'Secret',
      visibility: 'private',
    });
    ctx.videoStore.seedReadyMediaAsset(privateDraft.id);
    await publishOwned(ctx, privateDraft.id);

    await createOwnedDraft(ctx, { title: 'Draft stay', visibility: 'public' });

    const firstPage = await listPublicVideos(
      new NextRequest('https://vidak.example/api/videos/public?limit=2'),
    );
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as {
      items: Array<{ title: string; visibility: string; publicVideoId: string }>;
      nextCursor?: string;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.items.every((item) => item.visibility === 'public')).toBe(true);
    expect(firstBody.items.map((item) => item.publicVideoId)).not.toContain(
      unlistedPublished.publicVideoId,
    );
    expect(firstBody.nextCursor).toBe('offset:2');

    const secondPage = await listPublicVideos(
      new NextRequest(
        `https://vidak.example/api/videos/public?limit=2&cursor=${firstBody.nextCursor}`,
      ),
    );
    expect(secondPage.status).toBe(200);
    const secondBody = (await secondPage.json()) as {
      items: Array<{ title: string; publicVideoId: string }>;
      nextCursor?: string;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeUndefined();

    const allTitles = [...firstBody.items, ...secondBody.items].map((item) => item.title).sort();
    expect(allTitles).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(
      [...firstBody.items, ...secondBody.items].map((item) => item.publicVideoId).sort(),
    ).toEqual([...publicIds].sort());
  });

  it('streams ready media for published public and unlisted videos anonymously', async () => {
    const ctx = await createPublishingContext({ withMedia: true });
    const payload = new TextEncoder().encode('public-stream-bytes');

    const publicDraft = await createOwnedDraft(ctx, {
      title: 'Stream public',
      visibility: 'public',
    });
    ctx.mediaStore.registerOwnedDraft(publicDraft.id, ctx.ownerId);
    const publicAsset = await uploadReadyMedia(ctx, publicDraft.id, payload);
    ctx.videoStore.seedReadyMediaAsset(publicDraft.id);
    const publicPublished = await publishOwned(ctx, publicDraft.id);

    const publicStream = await getPublicMediaContent(
      new NextRequest(
        `https://vidak.example/api/videos/public/${publicPublished.publicVideoId}/media/${publicAsset.id}/content`,
      ),
      {
        params: Promise.resolve({
          publicVideoId: publicPublished.publicVideoId,
          assetId: publicAsset.id,
        }),
      },
    );
    expect(publicStream.status).toBe(200);
    expect(publicStream.headers.get('Content-Type')).toBe('video/mp4');
    expect(publicStream.headers.get('Cache-Control')).toBe('private, no-store');
    expect(publicStream.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(publicStream.text()).resolves.toBe('public-stream-bytes');
    expect(JSON.stringify(Object.fromEntries(publicStream.headers.entries()))).not.toContain(
      rootDir,
    );

    const unlistedDraft = await createOwnedDraft(ctx, {
      title: 'Stream unlisted',
      visibility: 'unlisted',
    });
    ctx.mediaStore.registerOwnedDraft(unlistedDraft.id, ctx.ownerId);
    const unlistedAsset = await uploadReadyMedia(ctx, unlistedDraft.id, payload);
    ctx.videoStore.seedReadyMediaAsset(unlistedDraft.id);
    const unlistedPublished = await publishOwned(ctx, unlistedDraft.id);

    const unlistedStream = await getPublicMediaContent(
      new NextRequest(
        `https://vidak.example/api/videos/public/${unlistedPublished.publicVideoId}/media/${unlistedAsset.id}/content`,
      ),
      {
        params: Promise.resolve({
          publicVideoId: unlistedPublished.publicVideoId,
          assetId: unlistedAsset.id,
        }),
      },
    );
    expect(unlistedStream.status).toBe(200);
    await expect(unlistedStream.text()).resolves.toBe('public-stream-bytes');
  });

  it('denies public media for private published videos, drafts, and missing assets', async () => {
    const ctx = await createPublishingContext({ withMedia: true });
    const payload = new TextEncoder().encode('secret-bytes');

    const privateDraft = await createOwnedDraft(ctx, {
      title: 'Private media',
      visibility: 'private',
    });
    ctx.mediaStore.registerOwnedDraft(privateDraft.id, ctx.ownerId);
    const privateAsset = await uploadReadyMedia(ctx, privateDraft.id, payload);
    ctx.videoStore.seedReadyMediaAsset(privateDraft.id);
    const privatePublished = await publishOwned(ctx, privateDraft.id);

    const privateStream = await getPublicMediaContent(
      new NextRequest(
        `https://vidak.example/api/videos/public/${privatePublished.publicVideoId}/media/${privateAsset.id}/content`,
      ),
      {
        params: Promise.resolve({
          publicVideoId: privatePublished.publicVideoId,
          assetId: privateAsset.id,
        }),
      },
    );
    expect(privateStream.status).toBe(404);

    const draft = await createOwnedDraft(ctx, { title: 'Draft media', visibility: 'public' });
    ctx.mediaStore.registerOwnedDraft(draft.id, ctx.ownerId);
    const draftAsset = await uploadReadyMedia(ctx, draft.id, payload);
    const draftStream = await getPublicMediaContent(
      new NextRequest(
        `https://vidak.example/api/videos/public/pub_not_published/media/${draftAsset.id}/content`,
      ),
      {
        params: Promise.resolve({
          publicVideoId: 'pub_not_published',
          assetId: draftAsset.id,
        }),
      },
    );
    expect(draftStream.status).toBe(404);

    const publicDraft = await createOwnedDraft(ctx, {
      title: 'Missing asset',
      visibility: 'public',
    });
    ctx.videoStore.seedReadyMediaAsset(publicDraft.id);
    const published = await publishOwned(ctx, publicDraft.id);
    const missingAsset = await getPublicMediaContent(
      new NextRequest(
        `https://vidak.example/api/videos/public/${published.publicVideoId}/media/missing-asset/content`,
      ),
      {
        params: Promise.resolve({
          publicVideoId: published.publicVideoId,
          assetId: 'missing-asset',
        }),
      },
    );
    expect(missingAsset.status).toBe(404);
  });

  it('makes public detail and media inaccessible after unpublish', async () => {
    const ctx = await createPublishingContext({ withMedia: true });
    const payload = new TextEncoder().encode('soon-private');
    const draft = await createOwnedDraft(ctx, { title: 'Unpublish me', visibility: 'public' });
    ctx.mediaStore.registerOwnedDraft(draft.id, ctx.ownerId);
    const asset = await uploadReadyMedia(ctx, draft.id, payload);
    ctx.videoStore.seedReadyMediaAsset(draft.id);
    const published = await publishOwned(ctx, draft.id);

    const beforeDetail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${published.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(beforeDetail.status).toBe(200);

    await unpublishVideo(
      new NextRequest(`https://vidak.example/api/videos/${draft.id}/unpublish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.ownerToken}` },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );

    const afterDetail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${published.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(afterDetail.status).toBe(404);

    const afterStream = await getPublicMediaContent(
      new NextRequest(
        `https://vidak.example/api/videos/public/${published.publicVideoId}/media/${asset.id}/content`,
      ),
      {
        params: Promise.resolve({
          publicVideoId: published.publicVideoId,
          assetId: asset.id,
        }),
      },
    );
    expect(afterStream.status).toBe(404);

    const discovery = await listPublicVideos(
      new NextRequest('https://vidak.example/api/videos/public'),
    );
    const discoveryBody = (await discovery.json()) as {
      items: Array<{ publicVideoId: string }>;
    };
    expect(discoveryBody.items.map((item) => item.publicVideoId)).not.toContain(
      published.publicVideoId,
    );
  });

  it('streams primary public media with inline disposition and safe byte ranges', async () => {
    const ctx = await createPublishingContext({ withMedia: true });
    const payload = new TextEncoder().encode('ABCDEFGHIJ');

    const draft = await createOwnedDraft(ctx, { title: 'Primary media', visibility: 'public' });
    ctx.mediaStore.registerOwnedDraft(draft.id, ctx.ownerId);
    await uploadReadyMedia(ctx, draft.id, payload);
    ctx.videoStore.seedReadyMediaAsset(draft.id);
    const published = await publishOwned(ctx, draft.id);

    const detail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${published.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      mediaContentUrl?: string;
      publicVideoId: string;
    };
    expect(detailBody.mediaContentUrl).toBe(`/api/videos/public/${published.publicVideoId}/media`);
    expect(JSON.stringify(detailBody)).not.toMatch(/storageKey|asset-|media_/);

    const full = await getPublicPrimaryMedia(
      new NextRequest(`https://vidak.example/api/videos/public/${published.publicVideoId}/media`),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Type')).toBe('video/mp4');
    expect(full.headers.get('Content-Length')).toBe(String(payload.byteLength));
    expect(full.headers.get('Content-Disposition')).toMatch(/^inline;/);
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    expect(full.headers.get('Content-Range')).toBeNull();
    await expect(full.text()).resolves.toBe('ABCDEFGHIJ');

    const ranged = await getPublicPrimaryMedia(
      new NextRequest(`https://vidak.example/api/videos/public/${published.publicVideoId}/media`, {
        headers: { Range: 'bytes=2-5' },
      }),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(ranged.headers.get('Content-Length')).toBe('4');
    expect(ranged.headers.get('Accept-Ranges')).toBe('bytes');
    expect(ranged.headers.get('Content-Disposition')).toMatch(/^inline;/);
    await expect(ranged.text()).resolves.toBe('CDEF');

    const multipart = await getPublicPrimaryMedia(
      new NextRequest(`https://vidak.example/api/videos/public/${published.publicVideoId}/media`, {
        headers: { Range: 'bytes=0-1,2-3' },
      }),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(multipart.status).toBe(400);

    const unsatisfiable = await getPublicPrimaryMedia(
      new NextRequest(`https://vidak.example/api/videos/public/${published.publicVideoId}/media`, {
        headers: { Range: 'bytes=99-100' },
      }),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('denies primary public media for private, draft, foreign, and no-media videos', async () => {
    const ctx = await createPublishingContext({ withMedia: true });
    const payload = new TextEncoder().encode('secret-bytes');

    const privateDraft = await createOwnedDraft(ctx, {
      title: 'Private published',
      visibility: 'private',
    });
    ctx.mediaStore.registerOwnedDraft(privateDraft.id, ctx.ownerId);
    await uploadReadyMedia(ctx, privateDraft.id, payload);
    ctx.videoStore.seedReadyMediaAsset(privateDraft.id);
    const privatePublished = await publishOwned(ctx, privateDraft.id);

    await expect(
      getPublicPrimaryMedia(
        new NextRequest(
          `https://vidak.example/api/videos/public/${privatePublished.publicVideoId}/media`,
        ),
        { params: Promise.resolve({ publicVideoId: privatePublished.publicVideoId }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    const draft = await createOwnedDraft(ctx, { title: 'Still draft', visibility: 'public' });
    ctx.mediaStore.registerOwnedDraft(draft.id, ctx.ownerId);
    await uploadReadyMedia(ctx, draft.id, payload);
    await expect(
      getPublicPrimaryMedia(
        new NextRequest('https://vidak.example/api/videos/public/pub_not_published/media'),
        { params: Promise.resolve({ publicVideoId: 'pub_not_published' }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      getPublicPrimaryMedia(
        new NextRequest('https://vidak.example/api/videos/public/pub_missing/media'),
        { params: Promise.resolve({ publicVideoId: 'pub_missing' }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    // Published public video whose ready-media row was removed after publish gate.
    const emptyDraft = await createOwnedDraft(ctx, {
      title: 'No durable media',
      visibility: 'public',
    });
    ctx.videoStore.seedReadyMediaAsset(emptyDraft.id);
    const emptyPublished = await publishOwned(ctx, emptyDraft.id);
    await expect(
      getPublicPrimaryMedia(
        new NextRequest(
          `https://vidak.example/api/videos/public/${emptyPublished.publicVideoId}/media`,
        ),
        { params: Promise.resolve({ publicVideoId: emptyPublished.publicVideoId }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    const emptyDetail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${emptyPublished.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: emptyPublished.publicVideoId }) },
    );
    expect(emptyDetail.status).toBe(200);
    const emptyBody = (await emptyDetail.json()) as { mediaContentUrl?: string };
    expect(emptyBody.mediaContentUrl).toBeUndefined();
  });

  it('clears blob thumbnail URLs and returns durable public thumbnail URLs', async () => {
    const ctx = await createPublishingContext({ withMedia: true });
    const payload = new TextEncoder().encode('video-bytes');
    const thumbBytes = new TextEncoder().encode('jpeg-thumb-bytes');

    const draft = await createOwnedDraft(ctx, { title: 'IMG 1589', visibility: 'public' });
    ctx.mediaStore.registerOwnedDraft(draft.id, ctx.ownerId);

    const blobUpdate = await creatorVideo
      .getCreatorVideoService()
      .updateDraft(ctx.ownerToken, draft.id, {
        thumbnailUrl: 'blob:https://vidak.postplatforms.com/5a7f2e33-93c3-438d-9781-f897d3e1a58d',
      });
    expect(blobUpdate.thumbnailUrl).toBe('');

    await uploadReadyMedia(ctx, draft.id, payload);
    ctx.videoStore.seedReadyMediaAsset(draft.id);

    const thumbResponse = await uploadThumbnail(
      new NextRequest(`https://vidak.example/api/videos/drafts/${draft.id}/thumbnail`, {
        method: 'POST',
        body: chunkedBody(thumbBytes, 8),
        duplex: 'half',
        headers: {
          Authorization: `Bearer ${ctx.ownerToken}`,
          'Content-Type': 'image/jpeg',
          'Content-Length': String(thumbBytes.byteLength),
          'X-Original-Filename': 'thumb.jpg',
        },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(thumbResponse.status).toBe(201);
    const thumbVideo = (await thumbResponse.json()) as { thumbnailUrl: string };
    expect(thumbVideo.thumbnailUrl).toBe(`/api/videos/drafts/${draft.id}/thumbnail`);

    const published = await publishOwned(ctx, draft.id);
    const detail = await getPublicVideo(
      new NextRequest(`https://vidak.example/api/videos/public/${published.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      title: string;
      thumbnailUrl: string;
      mediaContentUrl?: string;
    };
    expect(detailBody.title).toBe('IMG 1589');
    expect(detailBody.thumbnailUrl).toBe(`/api/videos/public/${published.publicVideoId}/thumbnail`);
    expect(detailBody.thumbnailUrl).not.toMatch(/^blob:|^data:/);
    expect(detailBody.mediaContentUrl).toBe(`/api/videos/public/${published.publicVideoId}/media`);

    const thumbStream = await getPublicThumbnail(
      new NextRequest(
        `https://vidak.example/api/videos/public/${published.publicVideoId}/thumbnail`,
      ),
      { params: Promise.resolve({ publicVideoId: published.publicVideoId }) },
    );
    expect(thumbStream.status).toBe(200);
    expect(thumbStream.headers.get('Content-Type')).toBe('image/jpeg');
    expect(Buffer.from(await thumbStream.arrayBuffer()).toString('utf8')).toBe('jpeg-thumb-bytes');

    const discovery = await listPublicVideos(
      new NextRequest('https://vidak.example/api/videos/public'),
    );
    const discoveryBody = (await discovery.json()) as {
      items: Array<{ title: string; thumbnailUrl: string }>;
    };
    const listed = discoveryBody.items.find((item) => item.title === 'IMG 1589');
    expect(listed?.thumbnailUrl).toBe(`/api/videos/public/${published.publicVideoId}/thumbnail`);
  });
});

async function createPublishingContext(options?: { withMedia?: boolean }) {
  const authStore = new InMemoryW3dsAuthStore();
  const videoStore = new InMemoryCreatorVideoStore();
  const mediaStore = new InMemoryMediaAssetStore();

  const ownerToken = await loginAs(authStore, videoStore, {
    eName: '@creator.w3id',
    eVaultId: 'evault-creator',
    eVaultUri: 'https://evault.example/creator',
  });
  const ownerId = (await w3dsAuth.getW3dsAuthService().getSession(ownerToken)).user.id;

  // Always wire media service so public video enrichment can query ready assets.
  rootDir = await mkdtemp(join(tmpdir(), 'vidak-publish-routes-'));
  vi.spyOn(mediaAssetModule, 'getMediaAssetService').mockReturnValue(
    new MediaAssetService({
      store: mediaStore,
      storage: new LocalDiskMediaStorage(rootDir),
      limits: {
        maxUploadBytes: 1024 * 1024,
        allowedContentTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
      },
      resolveUser: async (accessToken) =>
        (await w3dsAuth.getW3dsAuthService().getSession(accessToken)).user,
    }),
  );
  void options?.withMedia;

  return { authStore, videoStore, mediaStore, ownerToken, ownerId };
}

async function createOwnedDraft(
  ctx: {
    ownerToken: string;
  },
  input: { title: string; visibility?: 'public' | 'unlisted' | 'private' },
): Promise<{ id: string }> {
  const created = await createDraft(
    new NextRequest('https://vidak.example/api/videos/drafts', {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        ...(input.visibility ? { visibility: input.visibility } : {}),
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.ownerToken}`,
      },
    }),
  );
  expect(created.status).toBe(201);
  return (await created.json()) as { id: string };
}

async function publishOwned(
  ctx: { ownerToken: string },
  videoId: string,
): Promise<{ publicVideoId: string }> {
  const response = await publishVideo(
    new NextRequest(`https://vidak.example/api/videos/${videoId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.ownerToken}` },
    }),
    { params: Promise.resolve({ videoId }) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { publicVideoId: string };
}

async function uploadReadyMedia(
  ctx: { ownerToken: string },
  videoId: string,
  payload: Uint8Array,
): Promise<{ id: string }> {
  const response = await uploadMedia(
    new NextRequest(`https://vidak.example/api/videos/drafts/${videoId}/media`, {
      method: 'POST',
      body: chunkedBody(payload, 8),
      duplex: 'half',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(payload.byteLength),
        'X-Original-Filename': 'clip.mp4',
        Authorization: `Bearer ${ctx.ownerToken}`,
      },
    }),
    { params: Promise.resolve({ videoId }) },
  );
  expect(response.status).toBe(201);
  const asset = (await response.json()) as { id: string; storageKey?: string };
  expect(asset).not.toHaveProperty('storageKey');
  return asset;
}

function chunkedBody(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

async function loginAs(
  authStore: W3dsAuthStore,
  videoStore: CreatorVideoStore,
  identity: VerifiedW3dsIdentity,
): Promise<string> {
  const verifier: W3dsIdentityVerifier = {
    verify: vi.fn().mockResolvedValue(identity),
  };
  const authService = new W3dsAuthService({
    config: {
      platformName: 'vidak',
      registryBaseUrl: 'https://registry.example',
      jwtSecret: 'a development-only test secret with at least 32 characters',
    },
    store: authStore,
    identityVerifier: verifier,
    now: () => 1_780_000_000_000,
  });
  vi.spyOn(w3dsAuth, 'getW3dsAuthService').mockReturnValue(authService);
  vi.spyOn(creatorVideo, 'getCreatorVideoService').mockReturnValue(
    new CreatorVideoService({
      store: videoStore,
      resolveUser: async (accessToken) => (await authService.getSession(accessToken)).user,
    }),
  );

  const offer = await authService.createOffer('https://vidak.example');
  await authService.completeOffer({
    w3id: identity.eName,
    session: offer.sessionId,
    signature: 'signature',
  });
  const cookieSession = await authService.getOfferSessionForCookie(offer.offerId);
  const accessToken = cookieSession.tokens.accessToken;
  if (!accessToken) throw new Error('Expected access token');
  return accessToken;
}
