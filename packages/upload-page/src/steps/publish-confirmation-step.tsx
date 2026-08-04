'use client';

import type { Video, VideoVisibility } from '@w3ds/types';
import { Badge, Button, EmptyState, LoadingButton, Text } from '@w3ds/ui';
import { videoCategoryLabels, videoLanguageLabels, visibilityLabels } from '../upload-constants';
import type { VideoDetailsValue } from './video-details-step';

export interface PublishConfirmationStepProps {
  details: VideoDetailsValue;
  visibility?: VideoVisibility | '';
  thumbnailUrl?: string;
  fileName?: string;
  isPublishing?: boolean;
  publishError?: string;
  publishedVideo?: Video;
  onPublish?: () => void;
  onWatch?: (video: Video) => void;
  onUploadAnother?: () => void;
}

export function PublishConfirmationStep({
  details,
  visibility,
  thumbnailUrl,
  fileName,
  isPublishing = false,
  publishError,
  publishedVideo,
  onPublish,
  onWatch,
  onUploadAnother,
}: PublishConfirmationStepProps) {
  if (publishedVideo) {
    return (
      <EmptyState
        icon="✓"
        title="Your video is live"
        description={`${publishedVideo.title} has been published as ${visibilityLabels[publishedVideo.visibility].toLocaleLowerCase()}.`}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => onWatch?.(publishedVideo)}>Watch video</Button>
            {onUploadAnother && (
              <Button variant="secondary" onClick={onUploadAnother}>
                Upload another
              </Button>
            )}
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <Text size="sm" tone="muted">
        Review your upload, then publish when everything looks right.
      </Text>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt="Selected thumbnail"
            className="aspect-video w-full rounded-md border border-border object-cover"
          />
        )}
        <div className="space-y-3">
          <div className="space-y-1">
            <Text className="font-semibold">{details.title || 'Untitled video'}</Text>
            {fileName && (
              <Text size="sm" tone="muted">
                File: {fileName}
              </Text>
            )}
          </div>
          {details.description && (
            <Text size="sm" tone="muted" className="whitespace-pre-wrap">
              {details.description}
            </Text>
          )}
          <div className="flex flex-wrap gap-2">
            {visibility && <Badge tone="primary">{visibilityLabels[visibility]}</Badge>}
            {details.category && (
              <Badge tone="muted">{videoCategoryLabels[details.category]}</Badge>
            )}
            {details.language && (
              <Badge tone="muted">{videoLanguageLabels[details.language]}</Badge>
            )}
          </div>
          {details.tags.length > 0 && (
            <Text size="sm" tone="muted">
              Tags: {details.tags.join(', ')}
            </Text>
          )}
        </div>
      </div>
      {publishError && (
        <Text size="sm" tone="danger" role="alert">
          {publishError}
        </Text>
      )}
      <LoadingButton loading={isPublishing} loadingText="Publishing" onClick={onPublish}>
        Publish video
      </LoadingButton>
    </div>
  );
}
