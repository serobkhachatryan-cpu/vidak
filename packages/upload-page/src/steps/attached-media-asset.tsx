'use client';

import type { DraftMediaAsset } from '@w3ds/types';
import { Button, Text } from '@w3ds/ui';
import { formatBytes } from '../upload-constants';

export interface AttachedMediaAssetProps {
  asset: DraftMediaAsset;
  /** Same-origin authenticated content path for private preview. */
  previewSrc?: string;
  isRemoving?: boolean;
  removeError?: string;
  onRemove?: () => void;
}

export function AttachedMediaAsset({
  asset,
  previewSrc,
  isRemoving = false,
  removeError,
  onRemove,
}: AttachedMediaAssetProps) {
  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-muted/40 p-4"
      data-testid="attached-media-asset"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Text className="font-semibold">Attached media</Text>
          <Text size="sm">{asset.originalFilename}</Text>
          <Text size="sm" tone="muted">
            {asset.contentType} · {formatBytes(asset.byteSize)} · {asset.uploadState}
          </Text>
        </div>
        {onRemove && (
          <Button
            type="button"
            variant="secondary"
            disabled={isRemoving}
            onClick={onRemove}
            aria-label="Remove attached media"
          >
            {isRemoving ? 'Removing…' : 'Remove'}
          </Button>
        )}
      </div>
      {previewSrc && asset.uploadState === 'ready' && (
        <video
          key={previewSrc}
          className="aspect-video w-full max-w-md rounded-md border border-border bg-black"
          controls
          preload="metadata"
          src={previewSrc}
          aria-label={`Preview of ${asset.originalFilename}`}
        >
          <track kind="captions" />
        </video>
      )}
      {removeError && (
        <Text size="sm" tone="danger" role="alert">
          {removeError}
        </Text>
      )}
    </div>
  );
}
