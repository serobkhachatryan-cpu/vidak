import { describe, expect, it } from 'vitest';
import {
  headerAccountCta,
  isValidPublicDisplayName,
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

  it('accepts chosen public names, including the neutral default', () => {
    expect(isValidPublicDisplayName('Ada Lovelace')).toBe(true);
    expect(isValidPublicDisplayName(NEUTRAL_PUBLIC_DISPLAY_NAME)).toBe(true);
    expect(isValidPublicDisplayName('creator')).toBe(true);
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
