import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryW3dsAwarenessVideoProjection,
  W3dsAwarenessVideoProjectionError,
} from './w3ds-awareness-video-projection';
import type { W3dsMappingRulesDocument } from './w3ds-mapping-rules';

vi.mock('server-only', () => ({}));

const mapping: W3dsMappingRulesDocument = {
  tableName: 'videos',
  entityType: 'video',
  schemaId: 'schema-video-configured',
  ownerEnamePath: 'w3ds_platform_users(ownerId.eName)',
  localToUniversalMap: {
    id: 'id',
    ownerEName: 'w3ds_platform_users(ownerId.eName),ownerEName',
    channelId: 'creator_channels(channelId.id),channelId',
    title: 'title',
    description: 'description',
    status: 'status',
    visibility: 'visibility',
    durationSeconds: 'durationSeconds',
    mediaFileUri: '__file(mediaFileUri),mediaFileUri',
    thumbnailUrl: '__file(thumbnailUrl),thumbnailFileUri',
    category: 'category',
    language: 'language',
    tags: 'tags',
    publicVideoId: 'publicVideoId',
    publishedAt: '__date(publishedAt)',
    createdAt: '__date(createdAt)',
    updatedAt: '__date(updatedAt)',
    viewCount: 'viewCount',
    likeCount: 'likeCount',
    commentCount: 'commentCount',
  },
};

function input(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    envelope: {
      id: 'global-video-1',
      w3id: '@creator.w3id',
      schemaId: mapping.schemaId,
      data: {
        id: 'remote-video-1',
        ownerEName: '@creator.w3id',
        channelId: 'global-channel-1',
        title: 'Inbound draft metadata',
        description: 'No remote media is adopted.',
        status: 'draft',
        visibility: 'private',
        durationSeconds: 42,
        category: 'education',
        language: 'en',
        tags: ['W3DS', ' metadata '],
        createdAt: '2026-08-21T01:00:00.000Z',
        updatedAt: '2026-08-21T01:01:00.000Z',
        ...overrides,
      },
    },
    mapping,
    mappingVersion: 1,
    now: Date.parse('2026-08-21T02:00:00.000Z'),
  };
}

function seededProjector() {
  const projector = new InMemoryW3dsAwarenessVideoProjection();
  projector.seedOwner({ id: 'user-local-1', eName: '@creator.w3id' });
  projector.seedChannel({
    id: 'channel-local-1',
    globalId: 'global-channel-1',
    ownerId: 'user-local-1',
    ownerEName: '@creator.w3id',
  });
  return projector;
}

describe('transactional Awareness Video projection', () => {
  it('creates one private draft metadata row, local/global mapping, and receipt', async () => {
    const projector = seededProjector();

    const first = await projector.project(input());
    const replay = await projector.project(input({ title: 'Must not overwrite on replay' }));

    expect(first.outcome).toBe('applied');
    expect(replay).toEqual({ outcome: 'duplicate', receiptId: first.receiptId });
    expect(projector.getReceipt('global-video-1')?.id).toBe(first.receiptId);
    expect(projector.getVideoByGlobalId('global-video-1')).toMatchObject({
      id: first.localId,
      ownerId: 'user-local-1',
      channelId: 'channel-local-1',
      title: 'Inbound draft metadata',
      status: 'draft',
      visibility: 'private',
      publicVideoId: null,
      publishedAt: null,
      category: 'education',
      language: 'en',
      tags: ['W3DS', 'metadata'],
    });
  });

  it('ignores published or public packets with a receipt and no product projection', async () => {
    const projector = seededProjector();

    const result = await projector.project(
      input({ status: 'published', visibility: 'public', publicVideoId: 'pub_remote_1' }),
    );

    expect(result.outcome).toBe('ignored');
    expect(projector.getReceipt('global-video-1')?.id).toBe(result.receiptId);
    expect(projector.getVideoByGlobalId('global-video-1')).toBeUndefined();
  });

  it('does not dereference or copy W3DS file references into the local product row', async () => {
    const projector = seededProjector();

    await projector.project(
      input({
        mediaFileUri: 'w3ds://file?id=@creator.w3id/immutable-media',
        thumbnailFileUri: 'w3ds://file?id=@creator.w3id/immutable-thumbnail',
      }),
    );

    expect(projector.getVideoByGlobalId('global-video-1')).toMatchObject({ thumbnailUrl: '' });
  });

  it('fails closed without an owned local Channel and does not reserve the receipt', async () => {
    const projector = new InMemoryW3dsAwarenessVideoProjection();
    projector.seedOwner({ id: 'user-local-1', eName: '@creator.w3id' });

    await expect(projector.project(input())).rejects.toBeInstanceOf(
      W3dsAwarenessVideoProjectionError,
    );
    expect(projector.getReceipt('global-video-1')).toBeUndefined();
    expect(projector.getVideoByGlobalId('global-video-1')).toBeUndefined();
  });

  it('rejects an owner mismatch before a product write or receipt', async () => {
    const projector = seededProjector();

    await expect(projector.project(input({ ownerEName: '@other.w3id' }))).rejects.toThrow(
      /does not match/i,
    );
    expect(projector.getReceipt('global-video-1')).toBeUndefined();
    expect(projector.getVideoByGlobalId('global-video-1')).toBeUndefined();
  });
});
