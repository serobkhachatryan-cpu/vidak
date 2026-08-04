'use client';

import { Button, Text } from '@w3ds/ui';
import { type ChangeEvent, type DragEvent, useId, useRef, useState } from 'react';
import { cx } from '../styles';
import { formatBytes, maxVideoFileSizeBytes, supportedVideoExtensions } from '../upload-constants';

export function SelectVideoStep({
  fileName,
  fileSize,
  error,
  onFileSelect,
}: {
  fileName?: string;
  fileSize?: number;
  error?: string;
  onFileSelect?: (file: File) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const accept = [...supportedVideoExtensions, 'video/mp4', 'video/webm', 'video/quicktime'].join(
    ',',
  );

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

  return (
    <div className="space-y-4">
      <form
        aria-describedby={error ? `${inputId}-error` : `${inputId}-hint`}
        onSubmit={(event) => event.preventDefault()}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setIsDragging(false);
        }}
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
          accept={accept}
          className="sr-only"
          onChange={onChange}
        />
      </form>
      <Text id={`${inputId}-hint`} size="sm" tone="muted">
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
        <Text id={`${inputId}-error`} size="sm" tone="danger" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
