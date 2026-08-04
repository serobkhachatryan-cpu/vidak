import { AuthenticationError, createAuthUser, getAuthProviderCapabilities } from '@w3ds/auth';
import type { UserProfile } from '@w3ds/types';
import { describe, expect, it } from 'vitest';
import { formatSettingsTimestamp } from './format';
import {
  authUserFromProductProfile,
  errorMessage,
  isAppLanguage,
  nextSettingsSection,
  profileFormFromProfile,
  resolveActiveSettingsSection,
  resolveSettingsPageState,
  settingsNavIndexForKey,
  settingsSectionsForCapabilities,
} from './settings-page-helpers';

const profile = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  id: 'user-ada',
  handle: 'ada-lovelace',
  displayName: 'Ada Lovelace',
  joinedAt: '2025-01-12T09:00:00.000Z',
  subscriberCount: 0,
  isVerified: false,
  ...overrides,
});

describe('errorMessage', () => {
  it('prefers AuthenticationError and Error messages', () => {
    expect(
      errorMessage(new AuthenticationError('Denied.', 'invalid_credentials'), 'fallback'),
    ).toBe('Denied.');
    expect(errorMessage(new Error('Boom'), 'fallback')).toBe('Boom');
    expect(errorMessage('nope', 'fallback')).toBe('fallback');
  });
});

describe('profileFormFromProfile', () => {
  it('maps profile fields and defaults missing bios', () => {
    expect(profileFormFromProfile(profile({ bio: 'Hello' }))).toEqual({
      displayName: 'Ada Lovelace',
      handle: 'ada-lovelace',
      bio: 'Hello',
    });
    expect(profileFormFromProfile(profile()).bio).toBe('');
  });
});

describe('resolveSettingsPageState', () => {
  it('prefers pending over error and distinguishes ready from empty', () => {
    expect(
      resolveSettingsPageState({ isPending: true, error: new Error('x'), hasProfile: false }),
    ).toBe('loading');
    expect(
      resolveSettingsPageState({ isPending: false, error: new Error('x'), hasProfile: true }),
    ).toBe('error');
    expect(resolveSettingsPageState({ isPending: false, error: null, hasProfile: true })).toBe(
      'ready',
    );
    expect(resolveSettingsPageState({ isPending: false, error: null, hasProfile: false })).toBe(
      'empty',
    );
  });
});

describe('settings navigation helpers', () => {
  it('moves through the vertical tablist with arrow, home, and end keys', () => {
    expect(settingsNavIndexForKey('ArrowDown', 0, 3)).toBe(1);
    expect(settingsNavIndexForKey('ArrowUp', 0, 3)).toBe(2);
    expect(settingsNavIndexForKey('Home', 2, 3)).toBe(0);
    expect(settingsNavIndexForKey('End', 0, 3)).toBe(2);
    expect(settingsNavIndexForKey('Enter', 0, 3)).toBeUndefined();
    expect(nextSettingsSection('profile', 'ArrowDown')).toBe('email');
    expect(nextSettingsSection('danger', 'ArrowDown')).toBe('profile');
  });

  it('gates password, email, sessions, and delete sections from auth capabilities', () => {
    const devSections = settingsSectionsForCapabilities(getAuthProviderCapabilities('dev'));
    expect(devSections).toContain('email');
    expect(devSections).toContain('password');
    expect(devSections).toContain('sessions');
    expect(devSections).toContain('danger');

    const w3dsSections = settingsSectionsForCapabilities(getAuthProviderCapabilities('w3ds'));
    expect(w3dsSections).not.toContain('email');
    expect(w3dsSections).not.toContain('password');
    expect(w3dsSections).toContain('sessions');
    expect(w3dsSections).not.toContain('danger');
    expect(w3dsSections).toContain('profile');
    expect(resolveActiveSettingsSection(w3dsSections, 'password')).toBe('profile');
  });

  it('patches auth users from product profiles without inventing password fields', () => {
    const user = createAuthUser({
      id: 'user-1',
      displayName: 'Old',
      roles: ['creator'],
      eName: '@old.w3id',
      eVaultId: 'evault-1',
      avatarUrl: 'https://example.com/old.png',
    });
    const next = authUserFromProductProfile(user, {
      id: 'user-1',
      handle: 'new-handle',
      displayName: 'New Name',
      joinedAt: '2025-01-01T00:00:00.000Z',
      subscriberCount: 0,
      isVerified: false,
      bio: 'Updated bio',
    });
    expect(next.displayName).toBe('New Name');
    expect(next.profile).toMatchObject({
      displayName: 'New Name',
      handle: 'new-handle',
      bio: 'Updated bio',
    });
    expect(next.avatarUrl).toBeUndefined();
    expect(next.eName).toBe('@old.w3id');
  });
});

describe('isAppLanguage', () => {
  it('narrows supported language codes', () => {
    expect(isAppLanguage('en')).toBe(true);
    expect(isAppLanguage('xx')).toBe(false);
  });
});

describe('formatSettingsTimestamp', () => {
  it('formats valid timestamps and falls back for invalid values', () => {
    expect(formatSettingsTimestamp('2026-08-04T10:00:00.000Z')).toMatch(/2026/);
    expect(formatSettingsTimestamp('not-a-date')).toBe('not-a-date');
  });
});
