'use client';

import type { DraftMediaAsset } from '@w3ds/types';
import { Button, ErrorState, Progress, Text } from '@w3ds/ui';
import { formatBytes, formatRemainingTime, formatSpeed } from '../upload-constants';
import { AttachedMediaAsset } from './attached-media-asset';

export type UploadProgressStatus =
  | 'idle'
  | 'validating'
  | 'uploading'
  | 'cancelled'
  | 'error'
  | 'complete';

export interface UploadProgressView {
  percent: number;
  bytesUploaded: number;
  bytesTotal: number;
  bytesPerSecond: number;
  remainingSeconds: number;
}

export type UploadProgressErrorKind = 'draft' | 'media';

export interface UploadProgressStepProps {
  fileName?: string;
  status?: UploadProgressStatus;
  progress?: UploadProgressView;
  error?: string;
  /** Distinguishes draft-save failures from media-transfer failures. */
  errorKind?: UploadProgressErrorKind;
  onCancel?: () => void;
  onRetry?: () => void;
  onEditDraft?: () => void;
  mediaAsset?: DraftMediaAsset;
  mediaPreviewSrc?: string;
  isRemovingMedia?: boolean;
  removeMediaError?: string;
  onRemoveMedia?: () => void;
}

export function UploadProgressStep({
  fileName,
  status = 'uploading',
  progress,
  error,
  errorKind = 'media',
  onCancel,
  onRetry,
  onEditDraft,
  mediaAsset,
  mediaPreviewSrc,
  isRemovingMedia,
  removeMediaError,
  onRemoveMedia,
}: UploadProgressStepProps) {
  if (status === 'idle') {
    return (
      <div className="space-y-2">
        <Text className="font-semibold">Ready to upload</Text>
        <Text size="sm" tone="muted">
          Select a supported video file to begin uploading to your draft.
        </Text>
      </div>
    );
  }

  if (status === 'validating') {
    return (
      <div className="space-y-2">
        <Text className="font-semibold">{fileName ?? 'Checking video'}</Text>
        <Text size="sm" tone="muted">
          Validating file format and size…
        </Text>
      </div>
    );
  }

  if (status === 'error' || status === 'cancelled') {
    const isDraftError = status === 'error' && errorKind === 'draft';
    return (
      <div className="space-y-4">
        <ErrorState
          title={
            status === 'cancelled'
              ? 'Upload cancelled'
              : isDraftError
                ? 'Could not save draft'
                : 'Upload failed'
          }
          description={
            error ??
            (status === 'cancelled'
              ? 'You can retry when you are ready to continue.'
              : isDraftError
                ? 'Save your draft before uploading a video.'
                : 'Something went wrong while uploading your video.')
          }
          {...(onRetry
            ? {
                retry: onRetry,
                retryLabel: isDraftError ? 'Retry saving draft' : 'Retry upload',
              }
            : {})}
        />
        {isDraftError && onEditDraft && (
          <Button type="button" variant="secondary" onClick={onEditDraft}>
            Complete draft details
          </Button>
        )}
      </div>
    );
  }

  const percent = progress?.percent ?? (status === 'complete' ? 100 : 0);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Text className="font-semibold">{fileName ?? 'Uploading video'}</Text>
        <Text size="sm" tone="muted">
          {status === 'complete' ? 'Upload complete' : 'Uploading to your draft…'}
        </Text>
      </div>
      <Progress value={percent} label="Upload progress" />
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Text size="sm" tone="muted">
          {percent}%
        </Text>
        {progress && (
          <>
            <Text size="sm" tone="muted">
              {formatBytes(progress.bytesUploaded)} of {formatBytes(progress.bytesTotal)}
            </Text>
            {status === 'uploading' && (
              <>
                <Text size="sm" tone="muted">
                  {formatSpeed(progress.bytesPerSecond)}
                </Text>
                <Text size="sm" tone="muted">
                  {formatRemainingTime(progress.remainingSeconds)}
                </Text>
              </>
            )}
          </>
        )}
      </div>
      {status === 'uploading' && onCancel && (
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel upload
        </Button>
      )}
      {status === 'complete' && mediaAsset && (
        <AttachedMediaAsset
          asset={mediaAsset}
          {...(mediaPreviewSrc !== undefined ? { previewSrc: mediaPreviewSrc } : {})}
          {...(isRemovingMedia !== undefined ? { isRemoving: isRemovingMedia } : {})}
          {...(removeMediaError !== undefined ? { removeError: removeMediaError } : {})}
          {...(onRemoveMedia ? { onRemove: onRemoveMedia } : {})}
        />
      )}
    </div>
  );
}
