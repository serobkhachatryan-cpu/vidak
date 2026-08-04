'use client';

import { Button, ErrorState, Progress, Text } from '@w3ds/ui';
import { formatBytes, formatRemainingTime, formatSpeed } from '../upload-constants';

export type UploadProgressStatus = 'uploading' | 'cancelled' | 'error' | 'complete';

export interface UploadProgressView {
  percent: number;
  bytesUploaded: number;
  bytesTotal: number;
  bytesPerSecond: number;
  remainingSeconds: number;
}

export interface UploadProgressStepProps {
  fileName?: string;
  status?: UploadProgressStatus;
  progress?: UploadProgressView;
  error?: string;
  onCancel?: () => void;
  onRetry?: () => void;
}

export function UploadProgressStep({
  fileName,
  status = 'uploading',
  progress,
  error,
  onCancel,
  onRetry,
}: UploadProgressStepProps) {
  if (status === 'error' || status === 'cancelled') {
    return (
      <ErrorState
        title={status === 'cancelled' ? 'Upload cancelled' : 'Upload failed'}
        description={
          error ??
          (status === 'cancelled'
            ? 'You can retry when you are ready to continue.'
            : 'Something went wrong while uploading your video.')
        }
        retry={onRetry}
        retryLabel="Retry upload"
      />
    );
  }

  const percent = progress?.percent ?? (status === 'complete' ? 100 : 0);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Text className="font-semibold">{fileName ?? 'Uploading video'}</Text>
        <Text size="sm" tone="muted">
          {status === 'complete' ? 'Upload complete' : 'Uploading to W3DS…'}
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
    </div>
  );
}
