import type { AuthUser } from '@w3ds/auth';
import { describe, expect, it } from 'vitest';
import { InMemoryCreatorVideoStore } from './creator-video-store';
import { VideoSharingError, VideoSharingService } from './video-sharing';
import {
  toW3dsRecordAccessControl,
  type VideoSharingPolicy,
  W3DS_ACL_FULL,
} from './video-sharing-policy';
import { InMemoryVideoSharingPolicyStore } from './video-sharing-store';

const owner: AuthUser = {
  id: 'owner-1',
  eName: '@owner.w3id',
  eVaultId: 'vault-owner',
  displayName: 'Owner',
  profile: { displayName: 'Owner' },
  permissions: {
    canUpload: true,
    canComment: true,
    canManageOwnChannels: true,
    canModerate: false,
    canAccessAdmin: false,
  },
  roles: [],
  capabilities: [],
};

const recipient: AuthUser = {
  id: 'recipient-1',
  eName: '@recipient.w3id',
  eVaultId: 'vault-recipient',
  displayName: 'Recipient',
  profile: { displayName: 'Recipient' },
  permissions: {
    canUpload: true,
    canComment: true,
    canManageOwnChannels: true,
    canModerate: false,
    canAccessAdmin: false,
  },
  roles: [],
  capabilities: [],
};

const stranger: AuthUser = {
  id: 'stranger-1',
  eName: '@stranger.w3id',
  eVaultId: 'vault-stranger',
  displayName: 'Stranger',
  profile: { displayName: 'Stranger' },
  permissions: {
    canUpload: true,
    canComment: true,
    canManageOwnChannels: true,
    canModerate: false,
    canAccessAdmin: false,
  },
  roles: [],
  capabilities: [],
};

async function createContext(
  options: {
    resolveRecipientEName?: (eName: string) => Promise<string>;
    createToken?: () => string;
  } = {},
) {
  const videoStore = new InMemoryCreatorVideoStore();
  const policyStore = new InMemoryVideoSharingPolicyStore();
  const channel = await videoStore.findOrCreateChannel({
    id: 'channel-1',
    ownerId: owner.id,
    handle: 'owner',
    name: 'Owner',
  });
  const draft = await videoStore.createDraft({
    id: 'video-1',
    channelId: channel.id,
    ownerId: owner.id,
    title: 'Private cut',
    description: '',
    tags: [],
    visibility: 'private',
    thumbnailUrl: '',
  });
  videoStore.seedReadyMediaAsset(draft.id);
  await videoStore.publishOwnedVideo(draft.id, owner.id, 'pub_video-1');
  const users = new Map([
    ['owner-token', owner],
    ['recipient-token', recipient],
    ['stranger-token', stranger],
  ]);
  const service = new VideoSharingService({
    videoStore,
    policyStore,
    resolveUser: async (token) => {
      const user = users.get(token);
      if (!user) throw new Error('unknown token');
      return user;
    },
    ...options,
    createToken: options.createToken ?? (() => 'share_9f7c22fb-7ea3-419d-a618-98b8427c4753'),
  });
  return { service, videoStore, draft };
}

describe('video sharing policy', () => {
  it('compiles only read-level W3DS ACL grants and the documented public requirement', () => {
    const privatePolicy: VideoSharingPolicy = {
      audience: 'private',
      readerENames: [],
      groupENames: [],
    };
    const peoplePolicy: VideoSharingPolicy = {
      audience: 'people',
      readerENames: ['@b.w3id', '@a.w3id'],
      groupENames: [],
    };
    const publicPolicy: VideoSharingPolicy = {
      audience: 'public',
      readerENames: [],
      groupENames: [],
    };

    expect(toW3dsRecordAccessControl(privatePolicy, owner.eName)).toEqual({
      v: 1,
      grants: [{ ename: owner.eName, perms: W3DS_ACL_FULL }],
      denials: { enames: [], conditions: [] },
      default_perms: 0,
      require: [],
    });
    expect(toW3dsRecordAccessControl(peoplePolicy, owner.eName)).toEqual({
      v: 1,
      grants: [
        { ename: owner.eName, perms: W3DS_ACL_FULL },
        { ename: '@b.w3id', perms: 1 },
        { ename: '@a.w3id', perms: 1 },
      ],
      denials: { enames: [], conditions: [] },
      default_perms: 0,
      require: [],
    });
    expect(toW3dsRecordAccessControl(publicPolicy, owner.eName)).toMatchObject({
      grants: [{ ename: owner.eName, perms: W3DS_ACL_FULL }],
      default_perms: 1,
      require: [[]],
    });
  });

  it('requires the named eID even when someone else has the private share URL', async () => {
    const { service, videoStore, draft } = await createContext();
    const policy = await service.updateOwnerPolicy('owner-token', draft.id, {
      audience: 'people',
      readerENames: [' @recipient.w3id ', '@recipient.w3id'],
    });

    expect(policy.readerENames).toEqual(['@recipient.w3id']);
    expect(policy.shareUrl).toBe('/watch/shared/share_9f7c22fb-7ea3-419d-a618-98b8427c4753');
    expect((await videoStore.getOwnedVideo(draft.id, owner.id))?.visibility).toBe('private');
    await expect(
      service.getSharedVideo('recipient-token', 'share_9f7c22fb-7ea3-419d-a618-98b8427c4753'),
    ).resolves.toMatchObject({ id: draft.id, title: 'Private cut' });
    await expect(
      service.getSharedVideo('stranger-token', 'share_9f7c22fb-7ea3-419d-a618-98b8427c4753'),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('revokes a copied private link immediately when the owner returns to private', async () => {
    const { service, draft } = await createContext();
    const granted = await service.updateOwnerPolicy('owner-token', draft.id, {
      audience: 'people',
      readerENames: ['@recipient.w3id'],
    });
    await service.updateOwnerPolicy('owner-token', draft.id, { audience: 'private' });

    await expect(
      service.getSharedVideo('recipient-token', granted.shareToken ?? ''),
    ).rejects.toBeInstanceOf(VideoSharingError);
  });

  it('rotates the locator when the recipient set changes', async () => {
    const tokens = [
      'share_11111111-1111-4111-8111-111111111111',
      'share_22222222-2222-4222-8222-222222222222',
    ];
    const { service, draft } = await createContext({
      createToken: () => tokens.shift() ?? 'share_exhausted',
    });
    const first = await service.updateOwnerPolicy('owner-token', draft.id, {
      audience: 'people',
      readerENames: ['@recipient.w3id'],
    });
    const second = await service.updateOwnerPolicy('owner-token', draft.id, {
      audience: 'people',
      readerENames: ['@new-recipient.w3id'],
    });

    expect(second.shareToken).not.toBe(first.shareToken);
    await expect(
      service.getSharedVideo('recipient-token', first.shareToken ?? ''),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('does not narrow the owner when their eName is accidentally listed as a recipient', () => {
    const policy: VideoSharingPolicy = {
      audience: 'people',
      readerENames: [owner.eName, '@recipient.w3id'],
      groupENames: [],
    };

    expect(toW3dsRecordAccessControl(policy, owner.eName).grants).toEqual([
      { ename: owner.eName, perms: W3DS_ACL_FULL },
      { ename: '@recipient.w3id', perms: 1 },
    ]);
  });

  it('uses the registry-canonical recipient identity and rejects adding the owner', async () => {
    const { service: canonicalService, draft: canonicalDraft } = await createContext({
      resolveRecipientEName: async (eName) =>
        eName === '@friend.alias' ? '@friend.canonical' : owner.eName,
    });

    await expect(
      canonicalService.updateOwnerPolicy('owner-token', canonicalDraft.id, {
        audience: 'people',
        readerENames: ['@friend.alias'],
      }),
    ).resolves.toMatchObject({ readerENames: ['@friend.canonical'] });

    const { service, draft } = await createContext();
    await expect(
      service.updateOwnerPolicy('owner-token', draft.id, {
        audience: 'people',
        readerENames: [owner.eName],
      }),
    ).rejects.toMatchObject({ code: 'owner_recipient_rejected', status: 400 });
  });

  it('does not pretend that a pasted group eName authorizes hosted bytes', async () => {
    const { service, draft } = await createContext();
    await expect(
      service.updateOwnerPolicy('owner-token', draft.id, {
        audience: 'groups',
        groupENames: ['@group.w3id'],
      }),
    ).rejects.toMatchObject({ code: 'group_sharing_unavailable', status: 503 });
  });
});
