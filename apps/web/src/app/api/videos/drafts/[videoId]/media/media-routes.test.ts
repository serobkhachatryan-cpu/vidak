import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as creatorVideo from '../../../../../../server/creator-video';
import {
  CreatorVideoService,
  type CreatorVideoStore,
  InMemoryCreatorVideoStore,
  resetCreatorVideoServiceForTests,
} from '../../../../../../server/creator-video';
import * as mediaAssetModule from '../../../../../../server/media-asset';
import {
  InMemoryMediaAssetStore,
  LocalDiskMediaStorage,
  MediaAssetService,
  resetMediaAssetServiceForTests,
} from '../../../../../../server/media-asset';
import * as w3dsAuth from '../../../../../../server/w3ds-auth';
import {
  InMemoryW3dsAuthStore,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsAuthStore,
  type W3dsIdentityVerifier,
  w3dsAccessCookieName,
} from '../../../../../../server/w3ds-auth';
import { POST as createDraft } from '../../route';
import { GET as getContent } from './[assetId]/content/route';
import { DELETE as deleteAsset, GET as getAsset } from './[assetId]/route';
import { POST as uploadMedia } from './route';

let rootDir = '';

describe('protected media transfer routes', () => {
  afterEach(async () => {
    resetMediaAssetServiceForTests();
    resetCreatorVideoServiceForTests();
    resetW3dsAuthServiceForTests();
    vi.restoreAllMocks();
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('returns 401 for anonymous media requests', async () => {
    await expect(
      uploadMedia(
        new NextRequest('https://vidak.example/api/videos/drafts/draft-1/media', {
          method: 'POST',
          body: new Uint8Array([1, 2, 3]),
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': '3',
            'X-Original-Filename': 'anon.mp4',
            Origin: 'https://vidak.example',
          },
        }),
        { params: Promise.resolve({ videoId: 'draft-1' }) },
      ),
    ).resolves.toMatchObject({ status: 401 });

    await expect(
      getAsset(new NextRequest('https://vidak.example/api/videos/drafts/draft-1/media/a1'), {
        params: Promise.resolve({ videoId: 'draft-1', assetId: 'a1' }),
      }),
    ).resolves.toMatchObject({ status: 401 });

    await expect(
      getContent(
        new NextRequest('https://vidak.example/api/videos/drafts/draft-1/media/a1/content'),
        { params: Promise.resolve({ videoId: 'draft-1', assetId: 'a1' }) },
      ),
    ).resolves.toMatchObject({ status: 401 });

    await expect(
      deleteAsset(
        new NextRequest('https://vidak.example/api/videos/drafts/draft-1/media/a1', {
          method: 'DELETE',
          headers: { Origin: 'https://vidak.example' },
        }),
        { params: Promise.resolve({ videoId: 'draft-1', assetId: 'a1' }) },
      ),
    ).resolves.toMatchObject({ status: 401 });
  });

  it('accepts cookie and bearer auth for streamed upload, metadata, download, and delete', async () => {
    const ctx = await createMediaTestContext();
    const payload = new TextEncoder().encode('streamed-video-bytes');

    const cookieUpload = await uploadMedia(
      new NextRequest(`https://vidak.example/api/videos/drafts/${ctx.draftId}/media`, {
        method: 'POST',
        body: chunkedBody(payload, 5),
        duplex: 'half',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(payload.byteLength),
          'X-Original-Filename': 'clip.mp4',
          Cookie: `${w3dsAccessCookieName}=${ctx.ownerToken}`,
          Origin: 'https://vidak.example',
        },
      }),
      { params: Promise.resolve({ videoId: ctx.draftId }) },
    );
    expect(cookieUpload.status).toBe(201);
    const cookieAsset = (await cookieUpload.json()) as Record<string, unknown>;
    expect(cookieAsset).toMatchObject({
      videoId: ctx.draftId,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      byteSize: payload.byteLength,
      uploadState: 'ready',
    });
    expect(cookieAsset).not.toHaveProperty('storageKey');
    expect(JSON.stringify(cookieAsset)).not.toContain(rootDir);

    const bearerUpload = await uploadMedia(
      new NextRequest(`https://vidak.example/api/videos/drafts/${ctx.draftId}/media`, {
        method: 'POST',
        body: chunkedBody(payload, 4),
        duplex: 'half',
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': String(payload.byteLength),
          'X-Original-Filename': 'other.webm',
          Authorization: `Bearer ${ctx.ownerToken}`,
        },
      }),
      { params: Promise.resolve({ videoId: ctx.draftId }) },
    );
    expect(bearerUpload.status).toBe(201);
    const bearerAsset = (await bearerUpload.json()) as { id: string };

    const metadata = await getAsset(
      new NextRequest(
        `https://vidak.example/api/videos/drafts/${ctx.draftId}/media/${bearerAsset.id}`,
        { headers: { Authorization: `Bearer ${ctx.ownerToken}` } },
      ),
      { params: Promise.resolve({ videoId: ctx.draftId, assetId: bearerAsset.id }) },
    );
    expect(metadata.status).toBe(200);
    const metadataBody = (await metadata.json()) as Record<string, unknown>;
    expect(metadataBody).toMatchObject({
      id: bearerAsset.id,
      contentType: 'video/webm',
      uploadState: 'ready',
    });
    expect(metadataBody).not.toHaveProperty('storageKey');

    const download = await getContent(
      new NextRequest(
        `https://vidak.example/api/videos/drafts/${ctx.draftId}/media/${bearerAsset.id}/content`,
        { headers: { Cookie: `${w3dsAccessCookieName}=${ctx.ownerToken}` } },
      ),
      { params: Promise.resolve({ videoId: ctx.draftId, assetId: bearerAsset.id }) },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Type')).toBe('video/webm');
    expect(download.headers.get('Content-Length')).toBe(String(payload.byteLength));
    expect(download.headers.get('Cache-Control')).toBe('private, no-store');
    expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(download.headers.get('Content-Disposition')).toContain('other.webm');
    expect(download.headers.get('Content-Disposition')).not.toContain(rootDir);
    await expect(download.text()).resolves.toBe('streamed-video-bytes');

    const deleted = await deleteAsset(
      new NextRequest(
        `https://vidak.example/api/videos/drafts/${ctx.draftId}/media/${bearerAsset.id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${ctx.ownerToken}` },
        },
      ),
      { params: Promise.resolve({ videoId: ctx.draftId, assetId: bearerAsset.id }) },
    );
    expect(deleted.status).toBe(204);

    const missing = await getAsset(
      new NextRequest(
        `https://vidak.example/api/videos/drafts/${ctx.draftId}/media/${bearerAsset.id}`,
        { headers: { Authorization: `Bearer ${ctx.ownerToken}` } },
      ),
      { params: Promise.resolve({ videoId: ctx.draftId, assetId: bearerAsset.id }) },
    );
    expect(missing.status).toBe(404);
  });

  it('returns 404 for cross-user media access', async () => {
    const ctx = await createMediaTestContext();
    const payload = new Uint8Array([1, 2, 3, 4]);
    const uploaded = await uploadMedia(
      new NextRequest(`https://vidak.example/api/videos/drafts/${ctx.draftId}/media`, {
        method: 'POST',
        body: payload,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(payload.byteLength),
          'X-Original-Filename': 'owner.mp4',
          Authorization: `Bearer ${ctx.ownerToken}`,
        },
      }),
      { params: Promise.resolve({ videoId: ctx.draftId }) },
    );
    const asset = (await uploaded.json()) as { id: string };

    const viewerToken = await loginAs(ctx.authStore, ctx.videoStore, ctx.mediaStore, {
      eName: '@viewer.w3id',
      eVaultId: 'evault-viewer',
      eVaultUri: 'https://evault.example/viewer',
    });

    await expect(
      getAsset(
        new NextRequest(
          `https://vidak.example/api/videos/drafts/${ctx.draftId}/media/${asset.id}`,
          { headers: { Authorization: `Bearer ${viewerToken}` } },
        ),
        { params: Promise.resolve({ videoId: ctx.draftId, assetId: asset.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      getContent(
        new NextRequest(
          `https://vidak.example/api/videos/drafts/${ctx.draftId}/media/${asset.id}/content`,
          { headers: { Authorization: `Bearer ${viewerToken}` } },
        ),
        { params: Promise.resolve({ videoId: ctx.draftId, assetId: asset.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      deleteAsset(
        new NextRequest(
          `https://vidak.example/api/videos/drafts/${ctx.draftId}/media/${asset.id}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${viewerToken}` },
          },
        ),
        { params: Promise.resolve({ videoId: ctx.draftId, assetId: asset.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      uploadMedia(
        new NextRequest(`https://vidak.example/api/videos/drafts/${ctx.draftId}/media`, {
          method: 'POST',
          body: payload,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': String(payload.byteLength),
            'X-Original-Filename': 'steal.mp4',
            Authorization: `Bearer ${viewerToken}`,
          },
        }),
        { params: Promise.resolve({ videoId: ctx.draftId }) },
      ),
    ).resolves.toMatchObject({ status: 404 });
  });

  it('rejects invalid content type and oversized uploads before and during streaming', async () => {
    const ctx = await createMediaTestContext({ maxUploadBytes: 16 });

    const badType = await uploadMedia(
      new NextRequest(`https://vidak.example/api/videos/drafts/${ctx.draftId}/media`, {
        method: 'POST',
        body: new Uint8Array([1, 2, 3]),
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': '3',
          'X-Original-Filename': 'doc.pdf',
          Authorization: `Bearer ${ctx.ownerToken}`,
        },
      }),
      { params: Promise.resolve({ videoId: ctx.draftId }) },
    );
    expect(badType.status).toBe(415);
    await expect(badType.json()).resolves.toMatchObject({
      error: { code: 'unsupported_media_type' },
    });

    const tooLargeHeader = await uploadMedia(
      new NextRequest(`https://vidak.example/api/videos/drafts/${ctx.draftId}/media`, {
        method: 'POST',
        body: new Uint8Array(20),
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '20',
          'X-Original-Filename': 'big.mp4',
          Authorization: `Bearer ${ctx.ownerToken}`,
        },
      }),
      { params: Promise.resolve({ videoId: ctx.draftId }) },
    );
    expect(tooLargeHeader.status).toBe(413);
    await expect(tooLargeHeader.json()).resolves.toMatchObject({
      error: { code: 'payload_too_large' },
    });

    // Declared size within limit, but streamed body exceeds Content-Length.
    const overstream = await uploadMedia(
      new NextRequest(`https://vidak.example/api/videos/drafts/${ctx.draftId}/media`, {
        method: 'POST',
        body: chunkedBody(new Uint8Array(12), 3),
        duplex: 'half',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '8',
          'X-Original-Filename': 'over.mp4',
          Authorization: `Bearer ${ctx.ownerToken}`,
        },
      }),
      { params: Promise.resolve({ videoId: ctx.draftId }) },
    );
    expect(overstream.status).toBe(413);
    await expect(
      ctx.mediaStore.listOwnedAssetsByVideoId(ctx.draftId, ctx.ownerId),
    ).resolves.toEqual([]);
    await expect(listStoredObjectNames(rootDir)).resolves.toEqual([]);
  });

  it('cleans up temporary files and incomplete records when an upload is interrupted', async () => {
    const ctx = await createMediaTestContext();
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial-'));
        controller.error(new Error('connection reset'));
      },
    });

    const response = await uploadMedia(
      new NextRequest(`https://vidak.example/api/videos/drafts/${ctx.draftId}/media`, {
        method: 'POST',
        body: failingBody,
        duplex: 'half',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': '20',
          'X-Original-Filename': 'broken.mp4',
          Authorization: `Bearer ${ctx.ownerToken}`,
        },
      }),
      { params: Promise.resolve({ videoId: ctx.draftId }) },
    );
    expect(response.status).toBe(500);
    await expect(
      ctx.mediaStore.listOwnedAssetsByVideoId(ctx.draftId, ctx.ownerId),
    ).resolves.toEqual([]);
    await expect(listStoredObjectNames(rootDir)).resolves.toEqual([]);
  });
});

async function createMediaTestContext(options?: { maxUploadBytes?: number }) {
  rootDir = await mkdtemp(join(tmpdir(), 'vidak-media-routes-'));
  const authStore = new InMemoryW3dsAuthStore();
  const videoStore = new InMemoryCreatorVideoStore();
  const mediaStore = new InMemoryMediaAssetStore();
  const storage = new LocalDiskMediaStorage(rootDir);

  const ownerToken = await loginAs(authStore, videoStore, mediaStore, {
    eName: '@creator.w3id',
    eVaultId: 'evault-creator',
    eVaultUri: 'https://evault.example/creator',
  });

  vi.spyOn(mediaAssetModule, 'getMediaAssetService').mockReturnValue(
    new MediaAssetService({
      store: mediaStore,
      storage,
      limits: {
        maxUploadBytes: options?.maxUploadBytes ?? 1024 * 1024,
        allowedContentTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
      },
      resolveUser: async (accessToken) =>
        (await w3dsAuth.getW3dsAuthService().getSession(accessToken)).user,
    }),
  );

  const created = await createDraft(
    new NextRequest('https://vidak.example/api/videos/drafts', {
      method: 'POST',
      body: JSON.stringify({ title: 'Media draft' }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
    }),
  );
  expect(created.status).toBe(201);
  const draft = (await created.json()) as { id: string; ownerId: string };
  mediaStore.registerOwnedDraft(draft.id, draft.ownerId);

  return {
    authStore,
    videoStore,
    mediaStore,
    storage,
    ownerToken,
    draftId: draft.id,
    ownerId: draft.ownerId,
  };
}

async function loginAs(
  authStore: W3dsAuthStore,
  videoStore: CreatorVideoStore,
  _mediaStore: InMemoryMediaAssetStore,
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

async function listStoredObjectNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.name === '.uploads') {
        const uploads = await readdir(join(dir, '.uploads'));
        names.push(...uploads.map((name) => `.uploads/${name}`));
        continue;
      }
      if (entry.isFile()) names.push(entry.name);
    }
    return names.sort();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
}
