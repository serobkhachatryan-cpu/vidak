import { describe, expect, it } from 'vitest';
import {
  isChosenPublicDisplayName,
  isPublicHandle,
  isReplaceableChannelName,
  isValidPublicDisplayName,
  looksLikeTechnicalIdentifier,
  NEUTRAL_PUBLIC_CHANNEL_NAME,
  NEUTRAL_PUBLIC_DISPLAY_NAME,
  presentPublicChannel,
  publicChannelNameFromOwner,
  repairedChannelName,
  SOURCE_NEUTRAL_CHANNEL_LABEL,
  toSafePublicChannelProjection,
} from './index';

const opaqueUuid = 'fd10387a-b0d3-5f9c-bf54-7214a491cace';
const localId = `w3ds_${opaqueUuid}`;
const productionHandle = 'fd10387a-b0d3-5f9c-bf54-7214a491-w3ds450ac914';

describe('public display name safety for channel records', () => {
  it('rejects UUID, eName, local-id, and w3ds channel names', () => {
    expect(isValidPublicDisplayName(opaqueUuid)).toBe(false);
    expect(isValidPublicDisplayName(`@${opaqueUuid}`)).toBe(false);
    expect(isValidPublicDisplayName('@creator.w3id')).toBe(false);
    expect(isValidPublicDisplayName(localId)).toBe(false);
    expect(isValidPublicDisplayName(productionHandle)).toBe(false);
    expect(looksLikeTechnicalIdentifier(productionHandle)).toBe(true);
    expect(isValidPublicDisplayName('Ada Lovelace')).toBe(true);
  });

  it('rejects UUID, eName, and local-id handles', () => {
    expect(isPublicHandle(opaqueUuid)).toBe(false);
    expect(isPublicHandle(localId)).toBe(false);
    expect(isPublicHandle(`@${opaqueUuid}`)).toBe(false);
    expect(isPublicHandle(productionHandle)).toBe(false);
    expect(isPublicHandle('ada-lovelace')).toBe(true);
  });
});

describe('channel name repair', () => {
  const identity = { id: localId, eName: `@${opaqueUuid}`, eVaultId: 'evault-creator' };

  it('replaces technical placeholders with the owner public name when safe', () => {
    expect(
      repairedChannelName({
        storedName: opaqueUuid,
        ownerDisplayName: 'Ada Lovelace',
        identity,
      }),
    ).toEqual({ name: 'Ada Lovelace', shouldPersist: true });
    expect(publicChannelNameFromOwner('Ada Lovelace', identity)).toBe('Ada Lovelace');
    expect(isChosenPublicDisplayName('Ada Lovelace', identity)).toBe(true);
  });

  it('uses Vidak channel when the owner has no chosen public name', () => {
    expect(
      repairedChannelName({
        storedName: localId,
        ownerDisplayName: NEUTRAL_PUBLIC_DISPLAY_NAME,
        identity,
      }),
    ).toEqual({ name: NEUTRAL_PUBLIC_CHANNEL_NAME, shouldPersist: true });
    expect(publicChannelNameFromOwner(`@${opaqueUuid}`, identity)).toBe(
      NEUTRAL_PUBLIC_CHANNEL_NAME,
    );
  });

  it('never overwrites a genuinely chosen channel name', () => {
    expect(isReplaceableChannelName('Cooking with Ada', identity)).toBe(false);
    expect(
      repairedChannelName({
        storedName: 'Cooking with Ada',
        ownerDisplayName: 'Ada Lovelace',
        identity,
      }),
    ).toEqual({ name: 'Cooking with Ada', shouldPersist: false });
  });
});

describe('safe public channel projection and presentation', () => {
  it('never emits technical identifiers on the public projection', () => {
    const projection = toSafePublicChannelProjection({
      id: 'channel-1',
      name: opaqueUuid,
      handle: productionHandle,
      ownerDisplayName: 'Ada Lovelace',
      identity: { id: localId, eName: `@${opaqueUuid}` },
      subscriberCount: 0,
    });
    expect(projection.name).toBe('Ada Lovelace');
    expect(projection.handle).toBe('');
    expect(JSON.stringify(projection)).not.toContain(opaqueUuid);
    expect(JSON.stringify(projection)).not.toMatch(/w3ds_/);
    expect(JSON.stringify(projection)).not.toContain('Unknown channel');
  });

  it('renders a readable label and link without technical identifier text', () => {
    const named = presentPublicChannel({
      id: 'channel-1',
      name: 'Ada Lovelace',
      handle: 'ada-lovelace',
    });
    expect(named).toEqual({
      label: 'Ada Lovelace',
      href: '/channel/channel-1',
      handle: 'ada-lovelace',
    });

    const placeholder = presentPublicChannel({
      id: 'channel-1',
      name: opaqueUuid,
      handle: productionHandle,
    });
    expect(placeholder.label).toBe(NEUTRAL_PUBLIC_CHANNEL_NAME);
    expect(placeholder.href).toBe('/channel/channel-1');
    expect(placeholder.handle).toBeUndefined();
    expect(JSON.stringify(placeholder)).not.toContain(opaqueUuid);

    const source = presentPublicChannel(undefined);
    expect(source).toEqual({ label: SOURCE_NEUTRAL_CHANNEL_LABEL });
    expect(source.href).toBeUndefined();
  });
});
