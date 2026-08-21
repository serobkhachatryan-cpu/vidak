'use client';

import type { DraftMediaAsset, Video, VideoVisibility } from '@w3ds/types';
import { Badge, Button, EmptyState, LoadingButton, Text } from '@w3ds/ui';
import type { ReactNode } from 'react';
import { videoCategoryLabels, videoLanguageLabels, visibilityLabels } from '../upload-constants';
import type { VideoDetailsValue } from './video-details-step';

export interface PublishConfirmationStepProps {
  details: VideoDetailsValue;
  visibility?: VideoVisibility | '';
  thumbnailUrl?: string;
  fileName?: string;
  mediaAsset?: DraftMediaAsset;
  isPublishing?: boolean;
  isSavingDraft?: boolean;
  isUnpublishing?: boolean;
  publishError?: string;
  /** Saved draft or published video from the final step. */
  publishedVideo?: Video;
  /** Absolute or root-relative share URL using only publicVideoId. */
  shareUrl?: string;
  /** Product-owned approval UI rendered without coupling this package to a protocol. */
  publishApproval?: ReactNode;
  publishActionLabel?: string;
  onPublish?: () => void;
  onSaveDraft?: () => void;
  onUnpublish?: () => void;
  onWatch?: (video: Video) => void;
  onUploadAnother?: () => void;
}

function statusBadge(video: Video) {
  if (video.status === 'published') {
    return <Badge tone="primary">Published · {visibilityLabels[video.visibility]}</Badge>;
  }
  return <Badge tone="muted">Draft · {visibilityLabels[video.visibility]}</Badge>;
}

export function PublishConfirmationStep({
  details,
  visibility,
  thumbnailUrl,
  fileName,
  mediaAsset,
  isPublishing = false,
  isSavingDraft = false,
  isUnpublishing = false,
  publishError,
  publishedVideo,
  shareUrl,
  publishApproval,
  publishActionLabel = 'Publish',
  onPublish,
  onSaveDraft,
  onUnpublish,
  onWatch,
  onUploadAnother,
}: PublishConfirmationStepProps) {
  const hasReadyMedia = mediaAsset?.uploadState === 'ready';
  const busy = isPublishing || isSavingDraft || isUnpublishing;

  if (publishedVideo) {
    const isDraft = publishedVideo.status === 'draft';
    const isShareable =
      !isDraft &&
      (publishedVideo.visibility === 'public' || publishedVideo.visibility === 'unlisted') &&
      Boolean(publishedVideo.publicVideoId) &&
      Boolean(shareUrl);

    return (
      <EmptyState
        icon="✓"
        title={isDraft ? 'Draft saved' : 'Your video is live'}
        description={
          isDraft
            ? `${publishedVideo.title} is saved as a draft. It is not published and is not available on the public feed.`
            : `${publishedVideo.title} has been published as ${visibilityLabels[publishedVideo.visibility].toLocaleLowerCase()}.`
        }
        action={
          <div className="flex w-full max-w-lg flex-col items-center gap-4">
            <div className="flex flex-wrap justify-center gap-2">{statusBadge(publishedVideo)}</div>
            {isShareable && shareUrl && (
              <div className="w-full space-y-2 text-left">
                <Text size="sm" className="font-semibold">
                  Share link
                </Text>
                <Text
                  size="sm"
                  tone="muted"
                  className="break-all rounded-md border border-border bg-muted px-3 py-2 font-mono"
                  data-testid="share-link"
                >
                  {shareUrl}
                </Text>
                <Text size="sm" tone="muted">
                  This link uses the public video id only. It never includes storage keys or draft
                  ids.
                </Text>
              </div>
            )}
            {!isDraft && publishedVideo.visibility === 'private' && (
              <Text size="sm" tone="muted">
                Private published videos are not shareable and do not appear in public discovery.
              </Text>
            )}
            {isDraft && !hasReadyMedia && (
              <Text size="sm" tone="muted" role="status">
                Publishing stays disabled until this draft has a ready media asset.
              </Text>
            )}
            {publishError && (
              <Text size="sm" tone="danger" role="alert">
                {publishError}
              </Text>
            )}
            <div className="flex flex-wrap justify-center gap-2">
              {!isDraft && publishedVideo.publicVideoId && (
                <Button onClick={() => onWatch?.(publishedVideo)}>Watch video</Button>
              )}
              {isDraft && hasReadyMedia && onPublish && (
                <LoadingButton
                  loading={isPublishing}
                  loadingText="Publishing"
                  disabled={busy && !isPublishing}
                  onClick={onPublish}
                >
                  {publishActionLabel}
                </LoadingButton>
              )}
              {!isDraft && onUnpublish && (
                <LoadingButton
                  variant="secondary"
                  loading={isUnpublishing}
                  loadingText="Unpublishing"
                  disabled={busy && !isUnpublishing}
                  onClick={onUnpublish}
                >
                  Unpublish
                </LoadingButton>
              )}
              {onUploadAnother && (
                <Button
                  variant={isDraft && !hasReadyMedia ? 'primary' : 'secondary'}
                  onClick={onUploadAnother}
                  disabled={busy}
                >
                  Upload another
                </Button>
              )}
            </div>
          </div>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <Text size="sm" tone="muted">
        Review your details, then save a draft or publish. Publishing requires a ready media asset
        and uses your selected visibility.
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
            <Badge tone="muted">Draft</Badge>
            {hasReadyMedia ? (
              <Badge tone="primary">Media ready</Badge>
            ) : (
              <Badge tone="muted">No ready media</Badge>
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
      {!hasReadyMedia && (
        <Text size="sm" tone="muted" role="status">
          Publishing is disabled until this draft has a ready media asset. You can still save the
          draft metadata.
        </Text>
      )}
      {publishError && (
        <Text size="sm" tone="danger" role="alert">
          {publishError}
        </Text>
      )}
      {publishApproval}
      <div className="flex flex-wrap gap-2">
        {onSaveDraft && (
          <LoadingButton
            variant="secondary"
            loading={isSavingDraft}
            loadingText="Saving draft"
            disabled={busy && !isSavingDraft}
            onClick={onSaveDraft}
          >
            Save draft
          </LoadingButton>
        )}
        <LoadingButton
          loading={isPublishing}
          loadingText="Publishing"
          disabled={!hasReadyMedia || (busy && !isPublishing)}
          onClick={onPublish}
        >
          {publishActionLabel}
        </LoadingButton>
      </div>
    </div>
  );
}
