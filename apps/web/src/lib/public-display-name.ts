/**
 * Presentation and provisioning rules for a person's public name.
 * Technical identifiers (UUIDs, eNames, eVault IDs, local IDs) stay private.
 */

export const NEUTRAL_PUBLIC_DISPLAY_NAME = 'New Vidak member';
export const SET_PUBLIC_NAME_LABEL = 'Set your public name';
export const SETTINGS_PROFILE_HREF = '/settings?section=profile';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_PLATFORM_ID_PATTERN =
  /^w3ds_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicDisplayNameIdentity {
  id?: string;
  eName?: string;
  eVaultId?: string;
}

export function isValidPublicDisplayName(
  value: string | null | undefined,
  identity?: PublicDisplayNameIdentity,
): value is string {
  const name = value?.trim() ?? '';
  if (!name) return false;
  if (name.startsWith('@')) return false;
  if (UUID_PATTERN.test(name) || LOCAL_PLATFORM_ID_PATTERN.test(name)) return false;
  if (identity?.id && name === identity.id.trim()) return false;
  if (identity?.eVaultId && name === identity.eVaultId.trim()) return false;
  if (identity?.eName && name === identity.eName.trim()) return false;
  return true;
}

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
