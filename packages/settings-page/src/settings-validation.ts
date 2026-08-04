import {
  avatarFileAccept,
  deleteAccountConfirmation,
  maxAvatarFileSizeBytes,
  supportedAvatarMimeTypes,
} from './settings-constants';

export interface UploadFileLike {
  name: string;
  size: number;
  type: string;
}

export interface ProfileFormInput {
  displayName: string;
  handle: string;
  bio: string;
}

export interface ProfileFormErrors {
  displayName?: string;
  handle?: string;
  bio?: string;
}

export interface EmailFormInput {
  email: string;
  password: string;
}

export interface EmailFormErrors {
  email?: string;
  password?: string;
}

export interface PasswordFormInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface PasswordFormErrors {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
}

export interface DeleteAccountFormInput {
  password: string;
  confirmation: string;
}

export interface DeleteAccountFormErrors {
  password?: string;
  confirmation?: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const handlePattern = /^[a-z0-9][a-z0-9_-]{2,29}$/;

export function validateProfile(input: ProfileFormInput): ProfileFormErrors {
  const errors: ProfileFormErrors = {};
  const displayName = input.displayName.trim();
  if (!displayName) errors.displayName = 'Display name is required.';
  else if (displayName.length > 50)
    errors.displayName = 'Display name must be 50 characters or fewer.';

  const handle = input.handle.trim().replace(/^@/, '').toLocaleLowerCase();
  if (!handle) errors.handle = 'Username is required.';
  else if (!handlePattern.test(handle)) {
    errors.handle =
      'Username must be 3–30 characters and use letters, numbers, underscores, or hyphens.';
  }

  if (input.bio.length > 280) errors.bio = 'Bio must be 280 characters or fewer.';
  return errors;
}

export function hasProfileErrors(errors: ProfileFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function validateEmailChange(input: EmailFormInput): EmailFormErrors {
  const errors: EmailFormErrors = {};
  const email = input.email.trim();
  if (!email) errors.email = 'Email is required.';
  else if (!emailPattern.test(email)) errors.email = 'Enter a valid email address.';
  if (!input.password) errors.password = 'Current password is required.';
  return errors;
}

export function hasEmailErrors(errors: EmailFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function validatePasswordChange(input: PasswordFormInput): PasswordFormErrors {
  const errors: PasswordFormErrors = {};
  if (!input.currentPassword) errors.currentPassword = 'Current password is required.';
  if (!input.newPassword) errors.newPassword = 'New password is required.';
  else if (input.newPassword.length < 8) {
    errors.newPassword = 'New password must be at least 8 characters.';
  } else if (input.newPassword === input.currentPassword) {
    errors.newPassword = 'New password must be different from your current password.';
  }
  if (!input.confirmPassword) errors.confirmPassword = 'Confirm your new password.';
  else if (input.confirmPassword !== input.newPassword) {
    errors.confirmPassword = 'Passwords do not match.';
  }
  return errors;
}

export function hasPasswordErrors(errors: PasswordFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function validateDeleteAccount(input: DeleteAccountFormInput): DeleteAccountFormErrors {
  const errors: DeleteAccountFormErrors = {};
  if (!input.password) errors.password = 'Current password is required.';
  if (input.confirmation.trim() !== deleteAccountConfirmation) {
    errors.confirmation = `Type ${deleteAccountConfirmation} to confirm.`;
  }
  return errors;
}

export function hasDeleteAccountErrors(errors: DeleteAccountFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function validateAvatarFile(file: UploadFileLike | undefined): string | undefined {
  if (!file) return 'Select an image file.';
  if (!(supportedAvatarMimeTypes as readonly string[]).includes(file.type)) {
    return 'Unsupported avatar format. Use JPG, PNG, or WebP.';
  }
  if (file.size <= 0) return 'The selected avatar is empty.';
  if (file.size > maxAvatarFileSizeBytes) {
    return 'Avatar is too large. Maximum size is 5 MB.';
  }
  return undefined;
}

export { avatarFileAccept };
