import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import * as creatorVideo from '../../../../server/creator-video';
import {
  CreatorVideoService,
  type CreatorVideoStore,
  InMemoryCreatorVideoStore,
  resetCreatorVideoServiceForTests,
} from '../../../../server/creator-video';
import * as w3dsAuth from '../../../../server/w3ds-auth';
import {
  InMemoryW3dsAuthStore,
  resetW3dsAuthServiceForTests,
  type VerifiedW3dsIdentity,
  W3dsAuthService,
  type W3dsAuthStore,
  type W3dsIdentityVerifier,
} from '../../../../server/w3ds-auth';
import { GET as listOwnedVideos } from '../mine/route';
import { DELETE as deleteDraft, GET as getDraft, PATCH as updateDraft } from './[videoId]/route';
import { POST as createDraft, GET as listDrafts } from './route';

describe('video draft API routes', () => {
  afterEach(() => {
    resetCreatorVideoServiceForTests();
    resetW3dsAuthServiceForTests();
    vi.restoreAllMocks();
  });

  it('returns 401 for anonymous draft requests', async () => {
    await expect(
      listDrafts(new NextRequest('https://vidak.example/api/videos/drafts')),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      createDraft(
        new NextRequest('https://vidak.example/api/videos/drafts', {
          method: 'POST',
          body: JSON.stringify({ title: 'Anon' }),
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://vidak.example',
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      getDraft(new NextRequest('https://vidak.example/api/videos/drafts/draft-1'), {
        params: Promise.resolve({ videoId: 'draft-1' }),
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      listOwnedVideos(new NextRequest('https://vidak.example/api/videos/mine')),
    ).resolves.toMatchObject({ status: 401 });
  });

  it('creates, lists, reads, updates, and deletes drafts for an authenticated session', async () => {
    const authStore = new InMemoryW3dsAuthStore();
    const videoStore = new InMemoryCreatorVideoStore();
    const accessToken = await loginAs(authStore, videoStore, {
      eName: '@creator.w3id',
      eVaultId: 'evault-creator',
      eVaultUri: 'https://evault.example/creator',
    });

    const created = await createDraft(
      new NextRequest('https://vidak.example/api/videos/drafts', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Route draft',
          description: 'From the route test',
          tags: ['api'],
          category: 'education',
          language: 'en',
          visibility: 'private',
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; status: string; title: string };
    expect(createdBody).toMatchObject({ title: 'Route draft', status: 'draft' });

    const listed = await listDrafts(
      new NextRequest('https://vidak.example/api/videos/drafts', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      items: [{ id: createdBody.id, title: 'Route draft' }],
    });

    const owned = await listOwnedVideos(
      new NextRequest('https://vidak.example/api/videos/mine', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    expect(owned.status).toBe(200);
    await expect(owned.json()).resolves.toMatchObject({
      items: [{ id: createdBody.id, title: 'Route draft', status: 'draft' }],
    });

    const read = await getDraft(
      new NextRequest(`https://vidak.example/api/videos/drafts/${createdBody.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      { params: Promise.resolve({ videoId: createdBody.id }) },
    );
    expect(read.status).toBe(200);

    const updated = await updateDraft(
      new NextRequest(`https://vidak.example/api/videos/drafts/${createdBody.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Route draft updated' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }),
      { params: Promise.resolve({ videoId: createdBody.id }) },
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      title: 'Route draft updated',
      status: 'draft',
    });

    const deleted = await deleteDraft(
      new NextRequest(`https://vidak.example/api/videos/drafts/${createdBody.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      { params: Promise.resolve({ videoId: createdBody.id }) },
    );
    expect(deleted.status).toBe(204);
  });

  it('returns 404 when another authenticated user targets a draft', async () => {
    const authStore = new InMemoryW3dsAuthStore();
    const videoStore = new InMemoryCreatorVideoStore();

    const ownerToken = await loginAs(authStore, videoStore, {
      eName: '@creator.w3id',
      eVaultId: 'evault-creator',
      eVaultUri: 'https://evault.example/creator',
    });
    const created = await createDraft(
      new NextRequest('https://vidak.example/api/videos/drafts', {
        method: 'POST',
        body: JSON.stringify({ title: 'Owner only' }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
      }),
    );
    const draft = (await created.json()) as { id: string };

    const viewerToken = await loginAs(authStore, videoStore, {
      eName: '@viewer.w3id',
      eVaultId: 'evault-viewer',
      eVaultUri: 'https://evault.example/viewer',
    });
    const response = await getDraft(
      new NextRequest(`https://vidak.example/api/videos/drafts/${draft.id}`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      { params: Promise.resolve({ videoId: draft.id }) },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    });
  });
});

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
