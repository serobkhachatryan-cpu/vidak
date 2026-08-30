'use client';

import { Avatar, Button, Input, Label, Text, Textarea } from '@w3ds/ui';
import { type ChangeEvent, type ReactNode, useId, useRef } from 'react';
import { avatarFileAccept } from '../settings-constants';
import type { ProfileFormErrors, ProfileFormInput } from '../settings-validation';

export interface ProfileSectionProps {
  value: ProfileFormInput;
  avatarUrl?: string;
  errors?: ProfileFormErrors;
  avatarError?: string;
  successMessage?: string;
  formError?: string;
  isSaving?: boolean;
  isUploadingAvatar?: boolean;
  onChange: (patch: Partial<ProfileFormInput>) => void;
  onAvatarSelect: (file: File) => void;
  onSubmit: () => void;
  extras?: ReactNode;
}

export function ProfileSection({
  value,
  avatarUrl,
  errors,
  avatarError,
  successMessage,
  formError,
  isSaving = false,
  isUploadingAvatar = false,
  onChange,
  onAvatarSelect,
  onSubmit,
  extras,
}: ProfileSectionProps) {
  const displayNameId = useId();
  const handleId = useId();
  const bioId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onAvatarSelect(file);
    event.target.value = '';
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Avatar
          size="xl"
          {...(avatarUrl ? { src: avatarUrl } : {})}
          name={value.displayName || 'Profile'}
        />
        <div className="space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={avatarFileAccept}
            className="sr-only"
            aria-label="Upload avatar image"
            onChange={onFileChange}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            isLoading={isUploadingAvatar}
            loadingText="Uploading"
            onClick={() => fileInputRef.current?.click()}
          >
            Change avatar
          </Button>
          <Text size="sm" tone="muted">
            JPG, PNG, or WebP up to 5 MB.
          </Text>
          {avatarError && (
            <Text size="sm" tone="danger" role="alert">
              {avatarError}
            </Text>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={displayNameId}>Display name</Label>
        <Input
          id={displayNameId}
          value={value.displayName}
          invalid={Boolean(errors?.displayName)}
          aria-describedby={errors?.displayName ? `${displayNameId}-error` : undefined}
          autoComplete="nickname"
          maxLength={50}
          onChange={(event) => onChange({ displayName: event.target.value })}
        />
        {errors?.displayName && (
          <Text id={`${displayNameId}-error`} size="sm" tone="danger" role="alert">
            {errors.displayName}
          </Text>
        )}
        {extras}
      </div>

      <div className="space-y-2">
        <Label htmlFor={handleId}>Username</Label>
        <Input
          id={handleId}
          value={value.handle}
          invalid={Boolean(errors?.handle)}
          aria-describedby={errors?.handle ? `${handleId}-error` : undefined}
          autoComplete="username"
          maxLength={30}
          onChange={(event) => onChange({ handle: event.target.value })}
        />
        {errors?.handle && (
          <Text id={`${handleId}-error`} size="sm" tone="danger" role="alert">
            {errors.handle}
          </Text>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={bioId}>Bio</Label>
        <Textarea
          id={bioId}
          value={value.bio}
          invalid={Boolean(errors?.bio)}
          aria-describedby={errors?.bio ? `${bioId}-error` : undefined}
          maxLength={280}
          rows={4}
          onChange={(event) => onChange({ bio: event.target.value })}
        />
        <Text size="xs" tone="muted">
          {value.bio.length}/280
        </Text>
        {errors?.bio && (
          <Text id={`${bioId}-error`} size="sm" tone="danger" role="alert">
            {errors.bio}
          </Text>
        )}
      </div>

      {formError && (
        <Text size="sm" tone="danger" role="alert">
          {formError}
        </Text>
      )}
      {successMessage && (
        <Text size="sm" tone="success" role="status">
          {successMessage}
        </Text>
      )}

      <Button type="submit" isLoading={isSaving} loadingText="Saving">
        Save profile
      </Button>
    </form>
  );
}
