import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryW3dsAwarenessChannelProjection,
  W3dsAwarenessChannelProjectionError,
} from './w3ds-awareness-channel-projection';
import type { W3dsMappingRulesDocument } from './w3ds-mapping-rules';

vi.mock('server-only', () => ({}));

const mapping: W3dsMappingRulesDocument = {
  tableName: 'creator_channels',
  entityType: 'channel',
  schemaId: 'schema-channel-configured',
  ownerEnamePath: 'w3ds_platform_users(ownerId.eName)',
  localToUniversalMap: {
    id: 'id',
    ownerEName: 'w3ds_platform_users(ownerId.eName),ownerEName',
    handle: 'handle',
    name: 'name',
    description: 'description',
    avatarUrl: '__file(avatarUrl),avatarFileUri',
    bannerUrl: '__file(bannerUrl),bannerFileUri',
    subscriberCount: 'subscriberCount',
    videoCount: 'videoCount',
    createdAt: '__date(createdAt)',
    updatedAt: '__date(updatedAt)',
  },
};

function input(overrides: Partial<Record<string, unknown>> = {}) {
  const data = {
    id: 'remote-channel-1',
    ownerEName: '@creator.w3id',
    handle: 'creator',
    name: 'Creator',
    description: 'Metadata only',
    subscriberCount: 4,
    videoCount: 2,
    createdAt: '2026-08-21T01:00:00.000Z',
    updatedAt: '2026-08-21T01:01:00.000Z',
    ...overrides,
  };
  return {
    envelope: {
      id: 'global-channel-1',
      w3id: '@creator.w3id',
      schemaId: mapping.schemaId,
      data,
    },
    mapping,
    mappingVersion: 1,
    payloadHash: JSON.stringify(data),
    now: Date.parse('2026-08-21T02:00:00.000Z'),
  };
}

describe('transactional Awareness Channel projection', () => {
  it('deduplicates exact replays and updates a mapped Channel for a changed payload', async () => {
    const projector = new InMemoryW3dsAwarenessChannelProjection();
    projector.seedOwner({ id: 'user-local-1', eName: '@creator.w3id' });

    const first = await projector.project(input());
    const replay = await projector.project(input());
    const changed = await projector.project(
      input({ name: 'Updated Creator', updatedAt: '2026-08-21T01:02:00.000Z' }),
    );

    expect(first.outcome).toBe('applied');
    expect(replay).toEqual({ outcome: 'duplicate', receiptId: first.receiptId });
    expect(changed).toEqual({
      outcome: 'applied',
      receiptId: first.receiptId,
      localId: first.localId,
    });
    expect(projector.getReceipt('global-channel-1')?.id).toBe(first.receiptId);
    expect(projector.getChannelByGlobalId('global-channel-1')).toMatchObject({
      id: first.localId,
      ownerId: 'user-local-1',
      handle: 'creator',
      name: 'Updated Creator',
      subscriberCount: 4,
      videoCount: 2,
    });
  });

  it('fails closed without a local owner and does not reserve the receipt', async () => {
    const projector = new InMemoryW3dsAwarenessChannelProjection();

    await expect(projector.project(input())).rejects.toBeInstanceOf(
      W3dsAwarenessChannelProjectionError,
    );
    expect(projector.getReceipt('global-channel-1')).toBeUndefined();
    expect(projector.getChannelByGlobalId('global-channel-1')).toBeUndefined();
  });

  it('rejects an owner mismatch before a product write or receipt', async () => {
    const projector = new InMemoryW3dsAwarenessChannelProjection();
    projector.seedOwner({ id: 'user-local-1', eName: '@creator.w3id' });

    await expect(projector.project(input({ ownerEName: '@other.w3id' }))).rejects.toThrow(
      /does not match/i,
    );
    expect(projector.getReceipt('global-channel-1')).toBeUndefined();
  });

  it('does not dereference or copy a w3ds file URI into a browser-facing product URL', async () => {
    const projector = new InMemoryW3dsAwarenessChannelProjection();
    projector.seedOwner({ id: 'user-local-1', eName: '@creator.w3id' });

    await projector.project(
      input({ avatarFileUri: 'w3ds://file?id=@creator.w3id/immutable-avatar' }),
    );

    expect(projector.getChannelByGlobalId('global-channel-1')?.avatarUrl).toBeNull();
  });
});
