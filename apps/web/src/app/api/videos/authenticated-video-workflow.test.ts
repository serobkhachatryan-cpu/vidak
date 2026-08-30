import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createResourceAuthorizationProvider,
  createVideoResourceDescriptor,
  readResourceAuthorizationConfig,
  toResourceAuthSubject,
} from '../../../server/resource-authorization';
import {
  appOrigin,
  chunkedBody,
  createIntegrationHarness,
  type IntegrationHarness,
  testJwtSecret,
} from '../../../server/test/integration-harness';
import {
  resolveW3dsAuthorizationOfficialClient,
  W3DS_AUTHORIZATION_SDK_GAPS,
} from '../../../server/w3ds-authorization-sync';
import { POST as publishVideo } from './[videoId]/publish/route';
import { POST as unpublishVideo } from './[videoId]/unpublish/route';
import { GET as getContent } from './drafts/[videoId]/media/[assetId]/content/route';
import { DELETE as deleteAsset, GET as getAsset } from './drafts/[videoId]/media/[assetId]/route';
import { POST as uploadMedia } from './drafts/[videoId]/media/route';
import {
  DELETE as deleteDraft,
  GET as getDraft,
  PATCH as updateDraft,
} from './drafts/[videoId]/route';
import { POST as createDraft } from './drafts/route';
import { GET as getPublicMediaContent } from './public/[publicVideoId]/media/[assetId]/content/route';
import { GET as getPublicPrimaryMedia } from './public/[publicVideoId]/media/route';
import { GET as getPublicVideo } from './public/[publicVideoId]/route';
import { GET as listPublicVideos } from './public/route';

const creatorIdentity = {
  eName: '@creator.w3id',
  eVaultId: 'evault-creator',
  eVaultUri: 'https://evault.example/creator',
} as const;

const viewerIdentity = {
  eName: '@viewer.w3id',
  eVaultId: 'evault-viewer',
  eVaultUri: 'https://evault.example/viewer',
} as const;

describe('authenticated video workflow (end-to-end)', () => {
  let harness: IntegrationHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('covers auth → draft → media upload → publish → discover/play → unpublish → cross-user isolation', async () => {
    harness = await createIntegrationHarness();
    const payload = new TextEncoder().encode('workflow-video-bytes');

    // 1. Authenticate with the supported development W3DS offer flow (fake verifier).
    const creatorToken = await harness.loginAs(creatorIdentity);
    const creatorSession = await harness.authService.getSession(creatorToken);
    expect(creatorSession.user.eName).toBe(creatorIdentity.eName);

    // 2. Create and save a draft (bearer create, cookie save).
    const created = await createDraft(
      new NextRequest(`${appOrigin}/api/videos/drafts`, {
        method: 'POST',
        body: JSON.stringify({
          title: 'Workflow draft',
          description: 'End-to-end coverage',
          tags: ['e2e'],
          category: 'education',
          language: 'en',
          visibility: 'public',
        }),
        headers: {
          'Content-Type': 'application/json',
          ...harness.bearerHeaders(creatorToken),
        },
      }),
    );
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { id: string; status: string; title: string };
    expect(draft).toMatchObject({ title: 'Workflow draft', status: 'draft' });

    const saved = await updateDraft(
      new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Workflow draft saved', description: 'Persisted update' }),
        headers: {
          'Content-Type': 'application/json',
          ...harness.cookieHeaders(creatorToken),
        },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      id: draft.id,
      title: 'Workflow draft saved',
      status: 'draft',
    });

    // 3. Upload valid media through the protected streamed route (cookie + bearer).
    const cookieUpload = await uploadMedia(
      new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}/media`, {
        method: 'POST',
        body: chunkedBody(payload, 6),
        duplex: 'half',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(payload.byteLength),
          'X-Original-Filename': 'workflow.mp4',
          ...harness.cookieHeaders(creatorToken),
        },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(cookieUpload.status).toBe(201);
    const cookieAsset = (await cookieUpload.json()) as Record<string, unknown>;
    expect(cookieAsset).toMatchObject({
      uploadState: 'ready',
      contentType: 'video/mp4',
      byteSize: payload.byteLength,
    });
    expect(cookieAsset).not.toHaveProperty('storageKey');
    expect(JSON.stringify(cookieAsset)).not.toContain(harness.mediaRoot);

    const bearerUpload = await uploadMedia(
      new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}/media`, {
        method: 'POST',
        body: chunkedBody(payload, 5),
        duplex: 'half',
        headers: {
          'Content-Type': 'video/webm',
          'Content-Length': String(payload.byteLength),
          'X-Original-Filename': 'workflow.webm',
          ...harness.bearerHeaders(creatorToken),
        },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(bearerUpload.status).toBe(201);
    const primaryAsset = (await bearerUpload.json()) as { id: string };

    // Owner can stream protected draft media with either credential style.
    const ownerStream = await getContent(
      new NextRequest(
        `${appOrigin}/api/videos/drafts/${draft.id}/media/${primaryAsset.id}/content`,
        { headers: harness.cookieHeaders(creatorToken, false) },
      ),
      { params: Promise.resolve({ videoId: draft.id, assetId: primaryAsset.id }) },
    );
    expect(ownerStream.status).toBe(200);
    await expect(ownerStream.text()).resolves.toBe('workflow-video-bytes');

    // 4. Publish as public; confirm discovery / detail / playback.
    const published = await publishVideo(
      new NextRequest(`${appOrigin}/api/videos/${draft.id}/publish`, {
        method: 'POST',
        headers: harness.bearerHeaders(creatorToken),
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(published.status).toBe(200);
    const publishedBody = (await published.json()) as {
      id: string;
      status: string;
      visibility: string;
      publicVideoId: string;
    };
    expect(publishedBody).toMatchObject({
      id: draft.id,
      status: 'published',
      visibility: 'public',
    });
    expect(publishedBody.publicVideoId).toMatch(/^pub_/);

    const discovery = await listPublicVideos(new NextRequest(`${appOrigin}/api/videos/public`));
    expect(discovery.status).toBe(200);
    const discoveryBody = (await discovery.json()) as {
      items: Array<{
        publicVideoId: string;
        title: string;
        channel?: { name: string; id: string };
      }>;
    };
    expect(discoveryBody.items.map((item) => item.publicVideoId)).toContain(
      publishedBody.publicVideoId,
    );
    const listed = discoveryBody.items.find(
      (item) => item.publicVideoId === publishedBody.publicVideoId,
    );
    expect(listed?.title).toBe('Workflow draft saved');
    expect(listed?.channel?.name).toBeTruthy();
    expect(listed?.channel?.name).not.toBe('Unknown channel');
    expect(listed?.channel?.name).not.toMatch(/w3ds_/i);

    const detail = await getPublicVideo(
      new NextRequest(`${appOrigin}/api/videos/public/${publishedBody.publicVideoId}`),
      { params: Promise.resolve({ publicVideoId: publishedBody.publicVideoId }) },
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      id: draft.id,
      title: 'Workflow draft saved',
      status: 'published',
      publicVideoId: publishedBody.publicVideoId,
      mediaContentUrl: `/api/videos/public/${publishedBody.publicVideoId}/media`,
    });

    const primaryPlayback = await getPublicPrimaryMedia(
      new NextRequest(`${appOrigin}/api/videos/public/${publishedBody.publicVideoId}/media`),
      { params: Promise.resolve({ publicVideoId: publishedBody.publicVideoId }) },
    );
    expect(primaryPlayback.status).toBe(200);
    expect(primaryPlayback.headers.get('Content-Type')).toBe('video/mp4');
    expect(primaryPlayback.headers.get('Content-Disposition')).toMatch(/^inline;/);
    expect(primaryPlayback.headers.get('Accept-Ranges')).toBe('bytes');
    await expect(primaryPlayback.text()).resolves.toBe('workflow-video-bytes');

    const rangedPlayback = await getPublicPrimaryMedia(
      new NextRequest(`${appOrigin}/api/videos/public/${publishedBody.publicVideoId}/media`, {
        headers: { Range: 'bytes=0-7' },
      }),
      { params: Promise.resolve({ publicVideoId: publishedBody.publicVideoId }) },
    );
    expect(rangedPlayback.status).toBe(206);
    expect(rangedPlayback.headers.get('Content-Range')).toMatch(/^bytes 0-7\//);
    await expect(rangedPlayback.text()).resolves.toBe('workflow');

    const playback = await getPublicMediaContent(
      new NextRequest(
        `${appOrigin}/api/videos/public/${publishedBody.publicVideoId}/media/${primaryAsset.id}/content`,
      ),
      {
        params: Promise.resolve({
          publicVideoId: publishedBody.publicVideoId,
          assetId: primaryAsset.id,
        }),
      },
    );
    expect(playback.status).toBe(200);
    expect(playback.headers.get('Content-Type')).toBe('video/webm');
    await expect(playback.text()).resolves.toBe('workflow-video-bytes');

    // 5. Unpublish and confirm public access is removed.
    const unpublished = await unpublishVideo(
      new NextRequest(`${appOrigin}/api/videos/${draft.id}/unpublish`, {
        method: 'POST',
        headers: harness.cookieHeaders(creatorToken),
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(unpublished.status).toBe(200);
    await expect(unpublished.json()).resolves.toMatchObject({
      id: draft.id,
      status: 'draft',
      publicVideoId: publishedBody.publicVideoId,
    });

    await expect(
      getPublicVideo(
        new NextRequest(`${appOrigin}/api/videos/public/${publishedBody.publicVideoId}`),
        { params: Promise.resolve({ publicVideoId: publishedBody.publicVideoId }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      getPublicMediaContent(
        new NextRequest(
          `${appOrigin}/api/videos/public/${publishedBody.publicVideoId}/media/${primaryAsset.id}/content`,
        ),
        {
          params: Promise.resolve({
            publicVideoId: publishedBody.publicVideoId,
            assetId: primaryAsset.id,
          }),
        },
      ),
    ).resolves.toMatchObject({ status: 404 });

    const afterDiscovery = await listPublicVideos(
      new NextRequest(`${appOrigin}/api/videos/public`),
    );
    const afterDiscoveryBody = (await afterDiscovery.json()) as {
      items: Array<{ publicVideoId: string }>;
    };
    expect(afterDiscoveryBody.items.map((item) => item.publicVideoId)).not.toContain(
      publishedBody.publicVideoId,
    );

    // 6. Another authenticated user cannot access, modify, stream, or delete.
    const viewerToken = await harness.loginAs(viewerIdentity);

    await expect(
      getDraft(
        new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}`, {
          headers: harness.bearerHeaders(viewerToken),
        }),
        { params: Promise.resolve({ videoId: draft.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      updateDraft(
        new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: 'Stolen title' }),
          headers: {
            'Content-Type': 'application/json',
            ...harness.bearerHeaders(viewerToken),
          },
        }),
        { params: Promise.resolve({ videoId: draft.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      getAsset(
        new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}/media/${primaryAsset.id}`, {
          headers: harness.cookieHeaders(viewerToken),
        }),
        { params: Promise.resolve({ videoId: draft.id, assetId: primaryAsset.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      getContent(
        new NextRequest(
          `${appOrigin}/api/videos/drafts/${draft.id}/media/${primaryAsset.id}/content`,
          { headers: harness.bearerHeaders(viewerToken) },
        ),
        { params: Promise.resolve({ videoId: draft.id, assetId: primaryAsset.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      deleteAsset(
        new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}/media/${primaryAsset.id}`, {
          method: 'DELETE',
          headers: harness.bearerHeaders(viewerToken),
        }),
        { params: Promise.resolve({ videoId: draft.id, assetId: primaryAsset.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      deleteDraft(
        new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}`, {
          method: 'DELETE',
          headers: harness.cookieHeaders(viewerToken),
        }),
        { params: Promise.resolve({ videoId: draft.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    await expect(
      publishVideo(
        new NextRequest(`${appOrigin}/api/videos/${draft.id}/publish`, {
          method: 'POST',
          headers: harness.bearerHeaders(viewerToken),
        }),
        { params: Promise.resolve({ videoId: draft.id }) },
      ),
    ).resolves.toMatchObject({ status: 404 });

    // Creator still owns the draft after isolation checks.
    const stillOwned = await getDraft(
      new NextRequest(`${appOrigin}/api/videos/drafts/${draft.id}`, {
        headers: harness.bearerHeaders(creatorToken),
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(stillOwned.status).toBe(200);

    // W3DS authorization remains fail-closed without a live/official ACL client.
    const resolved = resolveW3dsAuthorizationOfficialClient();
    expect(resolved.status).toBe('unavailable');
    if (resolved.status === 'unavailable') {
      expect(resolved.missing).toEqual([...W3DS_AUTHORIZATION_SDK_GAPS]);
    }

    const authzConfig = readResourceAuthorizationConfig({
      AUTH_PROVIDER: 'w3ds',
      W3DS_REGISTRY_BASE_URL: 'https://registry.example.com',
      W3DS_AUTH_JWT_SECRET: testJwtSecret,
      DATABASE_URL: 'postgresql://vidak:vidak@127.0.0.1:5432/vidak',
    });
    const provider = createResourceAuthorizationProvider(authzConfig);
    expect(provider.capabilities()).toMatchObject({
      remoteGrantEvaluation: false,
      remoteGrantMutation: false,
      grantSynchronization: false,
    });
    expect(() => provider.requireCapability('grantSynchronization')).toThrow();

    const owner = toResourceAuthSubject(creatorSession.user);
    const viewer = toResourceAuthSubject((await harness.authService.getSession(viewerToken)).user);
    await expect(
      harness.authorizationSync.grant({
        resource: createVideoResourceDescriptor({
          localId: draft.id,
          owner: { platformUserId: owner.platformUserId, eName: owner.eName },
          visibility: 'private',
          status: 'draft',
        }),
        owner,
        subject: viewer,
        scope: 'video:read',
      }),
    ).rejects.toMatchObject({ code: 'sdk_unavailable', status: 503 });
  });
});
