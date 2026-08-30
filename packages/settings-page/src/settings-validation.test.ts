import { describe, expect, it } from 'vitest';
import {
  hasDeleteAccountErrors,
  hasEmailErrors,
  hasPasswordErrors,
  hasProfileErrors,
  validateAvatarFile,
  validateDeleteAccount,
  validateEmailChange,
  validatePasswordChange,
  validateProfile,
} from './settings-validation';

describe('settings validation', () => {
  it('validates profile fields', () => {
    expect(hasProfileErrors(validateProfile({ displayName: '', handle: '', bio: '' }))).toBe(true);
    expect(validateProfile({ displayName: 'Ada', handle: '', bio: 'Hello' })).toEqual({});
    expect(validateProfile({ displayName: 'Ada', handle: 'ada-lovelace', bio: 'Hello' })).toEqual(
      {},
    );
    expect(
      validateProfile({
        displayName: 'Ada',
        handle: 'w3ds_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        bio: '',
      }).handle,
    ).toMatch(/private identifier/);
    expect(validateProfile({ displayName: 'Ada', handle: 'ab', bio: 'x'.repeat(281) }).bio).toMatch(
      /280/,
    );
  });

  it('validates email changes', () => {
    expect(hasEmailErrors(validateEmailChange({ email: 'not-an-email', password: '' }))).toBe(true);
    expect(validateEmailChange({ email: 'ada@example.com', password: 'password123' })).toEqual({});
  });

  it('validates password changes', () => {
    expect(
      hasPasswordErrors(
        validatePasswordChange({
          currentPassword: 'password123',
          newPassword: 'short',
          confirmPassword: 'short',
        }),
      ),
    ).toBe(true);
    expect(
      validatePasswordChange({
        currentPassword: 'password123',
        newPassword: 'password456',
        confirmPassword: 'password456',
      }),
    ).toEqual({});
  });

  it('validates delete account confirmation', () => {
    expect(
      hasDeleteAccountErrors(validateDeleteAccount({ password: '', confirmation: 'delete' })),
    ).toBe(true);
    expect(validateDeleteAccount({ password: 'password123', confirmation: 'DELETE' })).toEqual({});
  });

  it('validates avatar files', () => {
    expect(validateAvatarFile(undefined)).toMatch(/Select/);
    expect(validateAvatarFile({ name: 'avatar.gif', size: 100, type: 'image/gif' })).toMatch(
      /Unsupported/,
    );
    expect(
      validateAvatarFile({ name: 'avatar.png', size: 100, type: 'image/png' }),
    ).toBeUndefined();
    expect(validateAvatarFile({ name: 'avatar.webp', size: 100, type: '' })).toBeUndefined();
  });
});
