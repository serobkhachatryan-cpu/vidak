/**
 * Presentation and provisioning rules for a person's public name.
 * Technical identifiers (UUIDs, eNames, eVault IDs, local IDs) stay private.
 */

import { isValidPublicDisplayName, type PublicDisplayNameIdentity } from '@w3ds/types';

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
