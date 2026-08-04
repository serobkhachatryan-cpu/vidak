'use client';

import { Button, Text } from '@w3ds/ui';
import { type ChangeEvent, useId, useRef } from 'react';
import { cx, focusWithinRing } from '../styles';
import { thumbnailFileAccept } from '../upload-constants';

export interface ThumbnailStepProps {
  autoThumbnails?: readonly string[];
  selectedUrl?: string;
  customPreviewUrl?: string;
  error?: string;
  onSelectAuto?: (url: string) => void;
  onCustomFileSelect?: (file: File) => void;
}

export function ThumbnailStep({
  autoThumbnails = [],
  selectedUrl,
  customPreviewUrl,
  error,
  onSelectAuto,
  onCustomFileSelect,
}: ThumbnailStepProps) {
  const inputId = useId();
  const groupName = `${inputId}-thumbnail`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onCustomFileSelect?.(file);
    event.target.value = '';
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Text className="font-semibold">Auto-generated thumbnails</Text>
        <Text size="sm" tone="muted">
          Pick a frame generated from your upload, or upload your own image.
        </Text>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {autoThumbnails.map((url, index) => {
            const selected = selectedUrl === url;
            const optionId = `${groupName}-auto-${index}`;
            return (
              <label
                key={url}
                htmlFor={optionId}
                className={cx(
                  'cursor-pointer overflow-hidden rounded-md border-2 border-border bg-surface transition-colors duration-fast',
                  focusWithinRing,
                  selected && 'border-primary',
                )}
              >
                <input
                  id={optionId}
                  type="radio"
                  name={groupName}
                  value={url}
                  checked={selected}
                  className="sr-only"
                  onChange={() => onSelectAuto?.(url)}
                />
                <img
                  src={url}
                  alt={`Auto-generated thumbnail ${index + 1}`}
                  className="aspect-video w-full object-cover"
                />
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <Text className="font-semibold">Custom thumbnail</Text>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()}>
            Upload thumbnail
          </Button>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={thumbnailFileAccept}
            aria-label="Upload a custom thumbnail"
            className="sr-only"
            onChange={onChange}
          />
          <Text size="sm" tone="muted">
            JPG, PNG, or WebP up to 5 MB.
          </Text>
        </div>
        {customPreviewUrl && (
          <label
            htmlFor={`${groupName}-custom`}
            className={cx(
              'block max-w-sm cursor-pointer overflow-hidden rounded-md border-2 border-border',
              focusWithinRing,
              selectedUrl === customPreviewUrl && 'border-primary',
            )}
          >
            <input
              id={`${groupName}-custom`}
              type="radio"
              name={groupName}
              value={customPreviewUrl}
              checked={selectedUrl === customPreviewUrl}
              className="sr-only"
              onChange={() => onSelectAuto?.(customPreviewUrl)}
            />
            <img
              src={customPreviewUrl}
              alt="Custom thumbnail preview"
              className="aspect-video w-full object-cover"
            />
          </label>
        )}
      </div>

      {error && (
        <Text id={errorId} size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
