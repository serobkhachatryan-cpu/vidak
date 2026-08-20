import { createAuthUser } from '@w3ds/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreatorVideoService, InMemoryCreatorVideoStore } from './creator-video';
import { W3dsAuthError } from './w3ds-auth';
import type { W3dsPrivateAdapterSyncService } from './w3ds-private-adapter-sync';
import type { PrivateAdapterSyncResult } from './w3ds-private-adapter-sync-types';

const owner = createAuthUser({
  id: 'user-owner',
  displayName: 'Owner',
  roles: ['creator'],
  eName: '@owner.w3id',
  eVaultId: 'evault-owner',
  handle: 'owner',
});

const other = createAuthUser({
  id: 'user-other',
  displayName: 'Other',
  roles: ['creator'],
  eName: '@other.w3id',
  eVaultId: 'evault-other',
  handle: 'other',
});

describe('CreatorVideoService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provisions a creator channel idempotently for the same owner', async () => {
    const store = new InMemoryCreatorVideoStore();
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    const first = await service.ensureCreatorChannel('token');
    const second = await service.ensureCreatorChannel('token');

    expect(first.id).toBe(second.id);
    expect(first.ownerId).toBe(owner.id);
    expect(first.handle).toContain('owner');
    expect(await store.findChannelByOwnerId(owner.id)).toMatchObject({ id: first.id });
  });

  it('creates, lists, reads, updates, and deletes owned drafts', async () => {
    const service = new CreatorVideoService({
      store: new InMemoryCreatorVideoStore(),
      resolveUser: async () => owner,
      createId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    const created = await service.createDraft('token', {
      title: 'Draft one',
      description: 'Editable metadata',
      tags: ['one'],
      category: 'education',
      language: 'en',
      visibility: 'unlisted',
      thumbnailUrl: 'https://example.com/a.jpg',
    });
    expect(created).toMatchObject({
      title: 'Draft one',
      status: 'draft',
      visibility: 'unlisted',
      category: 'education',
      language: 'en',
      thumbnailUrl: 'https://example.com/a.jpg',
    });
    expect(created.publishedAt).toBeUndefined();

    await expect(service.listDrafts('token')).resolves.toEqual([created]);
    await expect(service.getDraft('token', created.id)).resolves.toMatchObject({
      id: created.id,
      title: 'Draft one',
    });

    const updated = await service.updateDraft('token', created.id, {
      title: 'Draft one updated',
      visibility: 'private',
    });
    expect(updated).toMatchObject({
      title: 'Draft one updated',
      visibility: 'private',
      status: 'draft',
    });

    await service.deleteDraft('token', created.id);
    await expect(service.listDrafts('token')).resolves.toEqual([]);
    await expect(service.getDraft('token', created.id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('never persists blob or data thumbnail URLs on draft create/update', async () => {
    const service = new CreatorVideoService({
      store: new InMemoryCreatorVideoStore(),
      resolveUser: async () => owner,
      createId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    });

    const created = await service.createDraft('token', {
      title: 'IMG 1589',
      thumbnailUrl: 'blob:https://vidak.postplatforms.com/5a7f2e33-93c3-438d-9781-f897d3e1a58d',
    });
    expect(created.thumbnailUrl).toBe('');

    const updated = await service.updateDraft('token', created.id, {
      thumbnailUrl: 'data:image/png;base64,abc',
    });
    expect(updated.thumbnailUrl).toBe('');

    const restored = await service.updateDraft('token', created.id, {
      thumbnailUrl: `/api/videos/drafts/${created.id}/thumbnail`,
    });
    expect(restored.thumbnailUrl).toBe(`/api/videos/drafts/${created.id}/thumbnail`);
  });

  it('rejects anonymous callers with 401', async () => {
    const service = new CreatorVideoService({
      store: new InMemoryCreatorVideoStore(),
      resolveUser: async () => {
        throw new W3dsAuthError('Authentication is required.', 'invalid_session', 401);
      },
    });

    await expect(service.listDrafts('')).rejects.toMatchObject({
      code: 'invalid_session',
      status: 401,
    });
    await expect(service.createDraft('bad', { title: 'Nope' })).rejects.toMatchObject({
      code: 'invalid_session',
      status: 401,
    });
  });

  it('returns 404 for cross-user draft access without disclosing ownership', async () => {
    const store = new InMemoryCreatorVideoStore();
    let sequence = 0;
    const createId = () => `id-${++sequence}`;
    const ownerService = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId,
    });
    const otherService = new CreatorVideoService({
      store,
      resolveUser: async () => other,
      createId,
    });

    const draft = await ownerService.createDraft('owner-token', { title: 'Private draft' });

    await expect(otherService.getDraft('other-token', draft.id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(
      otherService.updateDraft('other-token', draft.id, { title: 'Hijack' }),
    ).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(otherService.deleteDraft('other-token', draft.id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(otherService.listDrafts('other-token')).resolves.toEqual([]);
    await expect(ownerService.getDraft('owner-token', draft.id)).resolves.toMatchObject({
      id: draft.id,
    });
  });

  it('publishes and unpublishes owned videos through the domain service', async () => {
    const store = new InMemoryCreatorVideoStore();
    let sequence = 0;
    const service = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId: () => `id-${++sequence}`,
    });

    const draft = await service.createDraft('token', {
      title: 'Ready to ship',
      visibility: 'private',
    });
    store.seedReadyMediaAsset(draft.id);

    const published = await service.publishVideo('token', draft.id);
    expect(published).toMatchObject({
      id: draft.id,
      status: 'published',
      visibility: 'private',
      publicVideoId: expect.stringMatching(/^pub_id-\d+$/),
    });
    expect(published.publishedAt).toEqual(expect.any(String));

    const again = await service.publishVideo('token', draft.id);
    expect(again).toEqual(published);

    const unpublished = await service.unpublishVideo('token', draft.id);
    expect(unpublished).toMatchObject({
      id: draft.id,
      status: 'draft',
      visibility: 'private',
      publicVideoId: published.publicVideoId,
    });
    expect(unpublished.publishedAt).toBeUndefined();

    await expect(service.listDrafts('token')).resolves.toEqual([
      expect.objectContaining({ id: draft.id, status: 'draft' }),
    ]);
  });

  it('rejects publish without ready media and hides cross-user publish/unpublish', async () => {
    const store = new InMemoryCreatorVideoStore();
    let sequence = 0;
    const createId = () => `id-${++sequence}`;
    const ownerService = new CreatorVideoService({
      store,
      resolveUser: async () => owner,
      createId,
    });
    const otherService = new CreatorVideoService({
      store,
      resolveUser: async () => other,
      createId,
    });

    const draft = await ownerService.createDraft('owner-token', { title: 'No media yet' });

    await expect(ownerService.publishVideo('owner-token', draft.id)).rejects.toMatchObject({
      code: 'precondition_failed',
      status: 409,
    });

    store.seedReadyMediaAsset(draft.id);
    await expect(otherService.publishVideo('other-token', draft.id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });

    const published = await ownerService.publishVideo('owner-token', draft.id);
    expect(published.status).toBe('published');

    await expect(otherService.unpublishVideo('other-token', draft.id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('keeps product mutations when private adapter sync fails', async () => {
    const failed: PrivateAdapterSyncResult = {
      outcome: 'failed',
      entityType: 'video',
      localId: 'unused',
      ownership: 'vidak_private',
      catalogueVisibility: 'private',
      interoperablePublicW3ds: false,
    };
    const syncCalls: string[] = [];
    const privateAdapterSync = {
      async syncChannelSafe() {
        syncCalls.push('channel');
        return { ...failed, entityType: 'channel' as const };
      },
      async syncVideoSafe() {
        syncCalls.push('video');
        throw new Error('private video sync exploded');
      },
    } as unknown as W3dsPrivateAdapterSyncService;

    const service = new CreatorVideoService({
      store: new InMemoryCreatorVideoStore(),
      resolveUser: async () => owner,
      createId: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
      privateAdapterSync,
    });

    const draft = await service.createDraft('token', { title: 'Local draft survives sync' });
    expect(draft).toMatchObject({
      title: 'Local draft survives sync',
      status: 'draft',
    });
    expect(draft.id).toBeTruthy();
    expect(syncCalls).toEqual(['channel', 'video']);
    await expect(service.listDrafts('token')).resolves.toEqual([draft]);
  });
});
