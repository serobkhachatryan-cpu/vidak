'use client';

import type { VideoCategory, VideoLanguage } from '@w3ds/types';
import { Button, Input, Label, Select, Tag, Text, Textarea } from '@w3ds/ui';
import { type FormEvent, type KeyboardEvent, useId, useState } from 'react';
import { videoCategoryOptions, videoLanguageOptions } from '../upload-constants';
import type { UploadDetailsErrors } from '../upload-validation';

export interface VideoDetailsValue {
  title: string;
  description: string;
  tags: readonly string[];
  category: VideoCategory | '';
  language: VideoLanguage | '';
}

export function VideoDetailsStep({
  value,
  errors,
  onChange,
}: {
  value: VideoDetailsValue;
  errors?: UploadDetailsErrors;
  onChange?: (patch: Partial<VideoDetailsValue>) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const tagsId = useId();
  const categoryId = useId();
  const languageId = useId();
  const [tagDraft, setTagDraft] = useState('');

  const addTag = (raw: string) => {
    const next = raw.trim().replace(/^#/, '');
    if (!next) return;
    if (value.tags.some((tag) => tag.toLocaleLowerCase() === next.toLocaleLowerCase())) {
      setTagDraft('');
      return;
    }
    onChange?.({ tags: [...value.tags, next] });
    setTagDraft('');
  };

  const onTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag(tagDraft);
    } else if (event.key === 'Backspace' && !tagDraft && value.tags.length > 0) {
      onChange?.({ tags: value.tags.slice(0, -1) });
    }
  };

  const onTagSubmit = (event: FormEvent) => {
    event.preventDefault();
    addTag(tagDraft);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={value.title}
          invalid={Boolean(errors?.title)}
          aria-describedby={errors?.title ? `${titleId}-error` : undefined}
          maxLength={100}
          required
          onChange={(event) => onChange?.({ title: event.target.value })}
        />
        {errors?.title && (
          <Text id={`${titleId}-error`} size="sm" tone="danger" role="alert">
            {errors.title}
          </Text>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={descriptionId}>Description</Label>
        <Textarea
          id={descriptionId}
          value={value.description}
          invalid={Boolean(errors?.description)}
          aria-describedby={errors?.description ? `${descriptionId}-error` : undefined}
          maxLength={5000}
          rows={5}
          onChange={(event) => onChange?.({ description: event.target.value })}
        />
        {errors?.description && (
          <Text id={`${descriptionId}-error`} size="sm" tone="danger" role="alert">
            {errors.description}
          </Text>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={tagsId}>Tags</Label>
        <form onSubmit={onTagSubmit} className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={tagsId}
            value={tagDraft}
            placeholder="Add a tag and press Enter"
            aria-describedby={errors?.tags ? `${tagsId}-error` : `${tagsId}-hint`}
            invalid={Boolean(errors?.tags)}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={onTagKeyDown}
          />
          <Button type="submit" variant="secondary">
            Add tag
          </Button>
        </form>
        <Text id={`${tagsId}-hint`} size="sm" tone="muted">
          Press Enter or comma to add. Up to 20 tags.
        </Text>
        {value.tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {value.tags.map((tag) => (
              <Tag
                key={tag}
                onRemove={() => onChange?.({ tags: value.tags.filter((item) => item !== tag) })}
                removeLabel={`Remove ${tag}`}
              >
                {tag}
              </Tag>
            ))}
          </div>
        )}
        {errors?.tags && (
          <Text id={`${tagsId}-error`} size="sm" tone="danger" role="alert">
            {errors.tags}
          </Text>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={categoryId}>Category</Label>
          <Select
            id={categoryId}
            value={value.category}
            invalid={Boolean(errors?.category)}
            aria-describedby={errors?.category ? `${categoryId}-error` : undefined}
            required
            onChange={(event) => onChange?.({ category: event.target.value as VideoCategory | '' })}
          >
            <option value="">Select a category</option>
            {videoCategoryOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {errors?.category && (
            <Text id={`${categoryId}-error`} size="sm" tone="danger" role="alert">
              {errors.category}
            </Text>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor={languageId}>Language</Label>
          <Select
            id={languageId}
            value={value.language}
            invalid={Boolean(errors?.language)}
            aria-describedby={errors?.language ? `${languageId}-error` : undefined}
            required
            onChange={(event) => onChange?.({ language: event.target.value as VideoLanguage | '' })}
          >
            <option value="">Select a language</option>
            {videoLanguageOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {errors?.language && (
            <Text id={`${languageId}-error`} size="sm" tone="danger" role="alert">
              {errors.language}
            </Text>
          )}
        </div>
      </div>
    </div>
  );
}
