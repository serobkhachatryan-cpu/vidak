import { AuthenticationError } from '@w3ds/auth';
import type { AppLanguage, UserProfile } from '@w3ds/types';
import { appLanguages } from '@w3ds/types';
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

export function profileFormFromProfile(profile: UserProfile): ProfileFormInput {
  return {
    displayName: profile.displayName,
    handle: profile.handle,
    bio: profile.bio ?? '',
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
): SettingsSectionId | undefined {
  const index = settingsNavIndexForKey(
    key,
    settingsSectionOrder.indexOf(current),
    settingsSectionOrder.length,
  );
  return index === undefined ? undefined : settingsSectionOrder[index];
}
