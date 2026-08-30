import { describe, expect, it } from 'vitest';
import {
  headerAccountCta,
  isPublicHandle,
  isReplaceableWithVerifiedFullName,
  isValidPublicDisplayName,
  isVerifiedFullNameUpgrade,
  NEUTRAL_PUBLIC_DISPLAY_NAME,
  SET_PUBLIC_NAME_LABEL,
  SETTINGS_PROFILE_HREF,
} from './public-display-name';

const opaqueUuid = 'fd10387a-b0d3-5f9c-bf54-7214a491cace';

describe('isValidPublicDisplayName', () => {
  it('rejects UUIDs, eNames, and missing values as presentation names', () => {
    expect(isValidPublicDisplayName(opaqueUuid)).toBe(false);
    expect(isValidPublicDisplayName(`@${opaqueUuid}`)).toBe(false);
    expect(isValidPublicDisplayName('@creator.w3id')).toBe(false);
    expect(isValidPublicDisplayName('  @ada.w3id  ')).toBe(false);
    expect(isValidPublicDisplayName(`w3ds_${opaqueUuid}`)).toBe(false);
    expect(isValidPublicDisplayName('')).toBe(false);
    expect(isValidPublicDisplayName('   ')).toBe(false);
    expect(isValidPublicDisplayName(undefined)).toBe(false);
    expect(isValidPublicDisplayName(null)).toBe(false);
  });

  it('rejects names that exactly match local or eVault identifiers', () => {
    expect(isValidPublicDisplayName(`w3ds_${opaqueUuid}`, { id: `w3ds_${opaqueUuid}` })).toBe(
      false,
    );
    expect(isValidPublicDisplayName('evault-creator', { eVaultId: 'evault-creator' })).toBe(false);
    expect(isValidPublicDisplayName('@creator.w3id', { eName: '@creator.w3id' })).toBe(false);
  });

  it('rejects the stale Creator placeholder', () => {
    expect(isValidPublicDisplayName('Creator')).toBe(false);
    expect(isValidPublicDisplayName('creator')).toBe(false);
    expect(isReplaceableWithVerifiedFullName('Creator')).toBe(true);
  });

  it('accepts chosen public names, including the neutral default', () => {
    expect(isValidPublicDisplayName('Ada Lovelace')).toBe(true);
    expect(isValidPublicDisplayName(NEUTRAL_PUBLIC_DISPLAY_NAME)).toBe(true);
    expect(isValidPublicDisplayName('Ada')).toBe(true);
  });
});

describe('isPublicHandle', () => {
  it('rejects local ids, UUIDs, and eNames as usernames', () => {
    expect(isPublicHandle(`w3ds_${opaqueUuid}`)).toBe(false);
    expect(isPublicHandle(opaqueUuid)).toBe(false);
    expect(isPublicHandle('@ada.w3id')).toBe(false);
    expect(isPublicHandle('ada-lovelace')).toBe(true);
    expect(isPublicHandle('')).toBe(false);
  });
});

describe('isVerifiedFullNameUpgrade', () => {
  it('allows completing a first-name grant to the document full name', () => {
    expect(isVerifiedFullNameUpgrade('Serob', 'Serob Kachatryan')).toBe(true);
    expect(isVerifiedFullNameUpgrade('Ada Chosen', 'Ada Lovelace')).toBe(false);
    expect(isVerifiedFullNameUpgrade('Ada Lovelace', 'Ada Lovelace')).toBe(false);
  });
});

describe('isReplaceableWithVerifiedFullName', () => {
  it('allows replacing the platform placeholder and identifier-shaped names', () => {
    expect(isReplaceableWithVerifiedFullName(NEUTRAL_PUBLIC_DISPLAY_NAME)).toBe(true);
    expect(isReplaceableWithVerifiedFullName('')).toBe(true);
    expect(isReplaceableWithVerifiedFullName(opaqueUuid)).toBe(true);
    expect(isReplaceableWithVerifiedFullName('@creator.w3id')).toBe(true);
  });

  it('protects a name the person already chose', () => {
    expect(isReplaceableWithVerifiedFullName('Ada Lovelace')).toBe(false);
    expect(isReplaceableWithVerifiedFullName('Ada Lovelace', { eName: '@creator.w3id' })).toBe(
      false,
    );
  });
});

describe('headerAccountCta', () => {
  it('replaces invalid names with a Profile settings CTA', () => {
    expect(headerAccountCta(opaqueUuid)).toEqual({
      label: SET_PUBLIC_NAME_LABEL,
      href: SETTINGS_PROFILE_HREF,
    });
    expect(headerAccountCta('@ada.w3id')).toEqual({
      label: SET_PUBLIC_NAME_LABEL,
      href: '/settings?section=profile',
    });
    expect(headerAccountCta('')).toEqual({
      label: SET_PUBLIC_NAME_LABEL,
      href: SETTINGS_PROFILE_HREF,
    });
  });

  it('keeps a real public name and still links to Profile settings', () => {
    expect(headerAccountCta('Ada Lovelace')).toEqual({
      label: 'Ada Lovelace',
      href: SETTINGS_PROFILE_HREF,
    });
  });
});
