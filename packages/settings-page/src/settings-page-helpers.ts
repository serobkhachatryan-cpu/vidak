import { AuthenticationError, type AuthProviderCapabilities, type AuthUser } from '@w3ds/auth';
import type { AppLanguage, UserProfile } from '@w3ds/types';
import {
  appLanguages,
  isPublicHandle,
  looksLikeTechnicalIdentifier,
  STALE_CREATOR_PLACEHOLDER,
} from '@w3ds/types';
import {
  type SettingsPageState,
  type SettingsSectionId,
  settingsSectionOrder,
} from './settings-constants';
import type { ProfileFormInput } from './settings-validation';

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthenticationError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function isStaleOrIdentifierDisplayName(value: string): boolean {
  const name = value.trim();
  if (!name) return true;
  if (name.toLocaleLowerCase() === STALE_CREATOR_PLACEHOLDER.toLocaleLowerCase()) return true;
  return looksLikeTechnicalIdentifier(name);
}

export function publicHandleOrEmpty(value: string | null | undefined, userId?: string): string {
  const handle = value?.trim().replace(/^@/, '') ?? '';
  if (!handle) return '';
  return isPublicHandle(handle, userId ? { id: userId } : undefined) ? handle : '';
}

export function profileFormFromProfile(profile: UserProfile): ProfileFormInput {
  return profileFormFromCanonical({
    authDisplayName: profile.displayName,
    authHandle: profile.handle,
    authUserId: profile.id,
    product: profile,
  });
}

export function profileFormFromCanonical(input: {
  authDisplayName: string;
  authHandle?: string;
  authUserId?: string;
  product?: UserProfile;
}): ProfileFormInput {
  const authName = input.authDisplayName.trim();
  const productName = input.product?.displayName?.trim() ?? '';
  const displayName = !isStaleOrIdentifierDisplayName(authName)
    ? authName
    : !isStaleOrIdentifierDisplayName(productName)
      ? productName
      : authName;
  return {
    displayName,
    handle: publicHandleOrEmpty(input.product?.handle ?? input.authHandle, input.authUserId),
    bio: input.product?.bio ?? '',
  };
}

export function resolveSettingsPageState({
  isPending,
  error,
  hasProfile,
}: {
  isPending: boolean;
  error: unknown;
  hasProfile: boolean;
}): SettingsPageState {
  if (isPending) return 'loading';
  if (error) return 'error';
  return hasProfile ? 'ready' : 'empty';
}

/**
 * Resolves which settings sections the active auth provider supports.
 * Password/email/delete/session panels are gated solely by {@link AuthProviderCapabilities}.
 */
export function settingsSectionsForCapabilities(
  capabilities: AuthProviderCapabilities,
): readonly SettingsSectionId[] {
  return settingsSectionOrder.filter((section) => {
    switch (section) {
      case 'email':
        return capabilities.changeEmail;
      case 'password':
        return capabilities.changePassword;
      case 'danger':
        return capabilities.deleteAccount;
      case 'sessions':
        return capabilities.manageSessions;
      case 'connected':
        return capabilities.connectExternalAccounts;
      default:
        return true;
    }
  });
}

export function resolveActiveSettingsSection(
  sections: readonly SettingsSectionId[],
  preferred: SettingsSectionId,
): SettingsSectionId {
  if (sections.includes(preferred)) return preferred;
  return sections[0] ?? 'profile';
}

export function parseSettingsSectionParam(
  value: string | null | undefined,
): SettingsSectionId | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  return settingsSectionOrder.find((section) => section === normalized);
}

/** Patches the auth session projection after a product-profile save when AuthClient profile APIs are unavailable. */
export function authUserFromProductProfile(user: AuthUser, profile: UserProfile): AuthUser {
  const { avatarUrl: _previousAvatar, ...userWithoutAvatar } = user;
  const { avatarUrl: _previousProfileAvatar, ...profileWithoutAvatar } = user.profile;
  return {
    ...userWithoutAvatar,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
    profile: {
      ...profileWithoutAvatar,
      displayName: profile.displayName,
      handle: profile.handle,
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      ...(profile.bio !== undefined ? { bio: profile.bio } : {}),
    },
  };
}

export function isAppLanguage(value: string): value is AppLanguage {
  return (appLanguages as readonly string[]).includes(value);
}

/** Roving tabindex keyboard targets for the vertical settings tablist. */
export function settingsNavIndexForKey(
  key: string,
  current: number,
  total: number,
): number | undefined {
  if (key === 'ArrowDown' || key === 'ArrowRight') return (current + 1) % total;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (current + total - 1) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return undefined;
}

export function nextSettingsSection(
  current: SettingsSectionId,
  key: string,
  sections: readonly SettingsSectionId[] = settingsSectionOrder,
): SettingsSectionId | undefined {
  const index = settingsNavIndexForKey(key, sections.indexOf(current), sections.length);
  return index === undefined ? undefined : sections[index];
}
