'use client';

import { Button, Text } from '@w3ds/ui';
import { type ChangeEvent, type DragEvent, useId, useRef, useState } from 'react';
import { cx } from '../styles';
import {
  formatBytes,
  maxVideoFileSizeBytes,
  supportedVideoExtensions,
  videoFileAccept,
} from '../upload-constants';

export interface SelectVideoStepProps {
  fileName?: string;
  fileSize?: number;
  error?: string;
  onFileSelect?: (file: File) => void;
}

export function SelectVideoStep({ fileName, fileSize, error, onFileSelect }: SelectVideoStepProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const dropzoneRef = useRef<HTMLFormElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onFileSelect?.(file);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  const onDragLeave = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && dropzoneRef.current?.contains(nextTarget)) return;
    setIsDragging(false);
  };

  return (
    <div className="space-y-4">
      <form
        ref={dropzoneRef}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hintId}
        onSubmit={(event) => event.preventDefault()}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cx(
          'flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-surface px-6 py-10 text-center transition-colors duration-fast',
          isDragging && 'border-primary bg-muted',
          error && 'border-danger',
        )}
      >
        <Text as="div" className="font-semibold">
          Drag and drop a video to upload
        </Text>
        <Text size="sm" tone="muted">
          or choose a file from your device
        </Text>
        <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()}>
          Select file
        </Button>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={videoFileAccept}
          aria-label="Select a video file"
          className="sr-only"
          onChange={onChange}
        />
      </form>
      <Text id={hintId} size="sm" tone="muted">
        Supported formats: {supportedVideoExtensions.join(', ')}. Max size{' '}
        {Math.round(maxVideoFileSizeBytes / (1024 * 1024 * 1024))} GB.
      </Text>
      {fileName && (
        <Text size="sm">
          Selected: {fileName}
          {fileSize !== undefined ? ` (${formatBytes(fileSize)})` : ''}
        </Text>
      )}
      {error && (
        <Text id={errorId} size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
