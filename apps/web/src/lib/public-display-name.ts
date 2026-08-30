/**
 * Presentation and provisioning rules for a person's public name.
 * Technical identifiers (UUIDs, eNames, eVault IDs, local IDs) stay private.
 */

import {
  isReplaceableWithVerifiedFullName,
  isValidPublicDisplayName,
  type PublicDisplayNameIdentity,
} from '@w3ds/types';

export {
  isChosenPublicDisplayName,
  isPlatformPlaceholderDisplayName,
  isPublicHandle,
  isReplaceableWithVerifiedFullName,
  isValidPublicDisplayName,
  isVerifiedFullNameUpgrade,
  looksLikeTechnicalIdentifier,
  NEUTRAL_PUBLIC_DISPLAY_NAME,
  type PublicDisplayNameIdentity,
  STALE_CREATOR_PLACEHOLDER,
} from '@w3ds/types';

export const SET_PUBLIC_NAME_LABEL = 'Set your public name';
export const USE_VERIFIED_NAME_LABEL = 'Use verified name from eID';
export const SETTINGS_PROFILE_HREF = '/settings?section=profile';

export function headerAccountCta(
  displayName: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): { label: string; href: typeof SETTINGS_PROFILE_HREF } {
  return {
    label: isValidPublicDisplayName(displayName, identity)
      ? displayName.trim()
      : SET_PUBLIC_NAME_LABEL,
    href: SETTINGS_PROFILE_HREF,
  };
}

/**
 * Non-blocking header link to Settings → Profile. Never a modal.
 * Shown only while the stored name is still replaceable.
 */
export function headerVerifiedNameCta(
  displayName: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): { label: typeof USE_VERIFIED_NAME_LABEL; href: typeof SETTINGS_PROFILE_HREF } | undefined {
  if (!isReplaceableWithVerifiedFullName(displayName, identity)) return undefined;
  return { label: USE_VERIFIED_NAME_LABEL, href: SETTINGS_PROFILE_HREF };
}
