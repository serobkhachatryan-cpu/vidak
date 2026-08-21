'use client';

import type {
  DraftMediaAsset,
  Video,
  VideoCategory,
  VideoLanguage,
  VideoVisibility,
} from '@w3ds/types';
import { AppShell, type AppShellProps, Button, Heading, Page, Text } from '@w3ds/ui';
import { type ReactNode, useId, useState } from 'react';
import { AttachedMediaAsset } from './steps/attached-media-asset';
import { PublishConfirmationStep } from './steps/publish-confirmation-step';
import { SelectVideoStep } from './steps/select-video-step';
import { ThumbnailStep } from './steps/thumbnail-step';
import {
  type UploadProgressErrorKind,
  type UploadProgressStatus,
  UploadProgressStep,
  type UploadProgressView,
} from './steps/upload-progress-step';
import { VideoDetailsStep, type VideoDetailsValue } from './steps/video-details-step';
import { VisibilityStep } from './steps/visibility-step';
import { cx } from './styles';
import {
  canNavigateToUploadStep,
  formatBytes,
  type UploadStepId,
  uploadStepLabels,
} from './upload-constants';
import { UploadStepper } from './upload-stepper';
import type { UploadDetailsErrors } from './upload-validation';

export interface UploadDraft {
  title: string;
  description: string;
  tags: readonly string[];
  category: VideoCategory | '';
  language: VideoLanguage | '';
  visibility: VideoVisibility | '';
  thumbnailUrl: string;
}

export const emptyUploadDraft = (): UploadDraft => ({
  title: '',
  description: '',
  tags: [],
  category: '',
  language: '',
  visibility: 'public',
  thumbnailUrl: '',
});

export interface UploadPageProps {
  step?: UploadStepId;
  defaultStep?: UploadStepId;
  onStepChange?: (step: UploadStepId) => void;
  completedSteps?: readonly UploadStepId[];
  fileName?: string;
  fileSize?: number;
  fileError?: string;
  onFileSelect?: (file: File) => void;
  uploadStatus?: UploadProgressStatus;
  progress?: UploadProgressView;
  uploadError?: string;
  uploadErrorKind?: UploadProgressErrorKind;
  onCancelUpload?: () => void;
  onRetryUpload?: () => void;
  onEditDraftFromUpload?: () => void;
  mediaAsset?: DraftMediaAsset;
  mediaPreviewSrc?: string;
  isRemovingMedia?: boolean;
  removeMediaError?: string;
  onRemoveMedia?: () => void;
  draft?: UploadDraft;
  onDraftChange?: (patch: Partial<UploadDraft>) => void;
  detailsErrors?: UploadDetailsErrors;
  thumbnailError?: string;
  visibilityError?: string;
  autoThumbnails?: readonly string[];
  customThumbnailUrl?: string;
  onCustomThumbnailSelect?: (file: File) => void;
  isPublishing?: boolean;
  isSavingDraft?: boolean;
  isUnpublishing?: boolean;
  publishError?: string;
  publishedVideo?: Video;
  shareUrl?: string;
  /** Optional product-owned approval UI rendered alongside the publish action. */
  publishApproval?: ReactNode;
  /** Product copy for a publish action that needs an approval step. */
  publishActionLabel?: string;
  onPublish?: () => void;
  onSaveDraft?: () => void;
  onUnpublish?: () => void;
  onWatch?: (video: Video) => void;
  onUploadAnother?: () => void;
  onContinue?: () => void;
  onBack?: () => void;
  shell?: Omit<AppShellProps, 'children'>;
  theme?: 'light' | 'dark';
  className?: string;
}

function stepDetails(draft: UploadDraft): VideoDetailsValue {
  return {
    title: draft.title,
    description: draft.description,
    tags: draft.tags,
    category: draft.category,
    language: draft.language,
  };
}

function canGoBack(step: UploadStepId, uploadStatus?: UploadProgressStatus): boolean {
  if (step === 'select') return false;
  if (step === 'progress' && uploadStatus === 'uploading') return false;
  return true;
}

export function UploadPage({
  step: controlledStep,
  defaultStep = 'select',
  onStepChange,
  completedSteps = [],
  fileName,
  fileSize,
  fileError,
  onFileSelect,
  uploadStatus,
  progress,
  uploadError,
  uploadErrorKind,
  onCancelUpload,
  onRetryUpload,
  onEditDraftFromUpload,
  mediaAsset,
  mediaPreviewSrc,
  isRemovingMedia,
  removeMediaError,
  onRemoveMedia,
  draft: draftProp,
  onDraftChange,
  detailsErrors,
  thumbnailError,
  visibilityError,
  autoThumbnails = [],
  customThumbnailUrl,
  onCustomThumbnailSelect,
  isPublishing,
  isSavingDraft,
  isUnpublishing,
  publishError,
  publishedVideo,
  shareUrl,
  publishApproval,
  publishActionLabel,
  onPublish,
  onSaveDraft,
  onUnpublish,
  onWatch,
  onUploadAnother,
  onContinue,
  onBack,
  shell,
  theme,
  className,
}: UploadPageProps) {
  const stepHeadingId = useId();
  const [uncontrolledStep, setUncontrolledStep] = useState<UploadStepId>(defaultStep);
  const [uncontrolledDraft, setUncontrolledDraft] = useState<UploadDraft>(emptyUploadDraft);
  const step = controlledStep ?? uncontrolledStep;
  const draft = draftProp ?? uncontrolledDraft;

  const setStep = (next: UploadStepId) => {
    if (controlledStep === undefined) setUncontrolledStep(next);
    onStepChange?.(next);
  };

  const patchDraft = (patch: Partial<UploadDraft>) => {
    if (draftProp === undefined) {
      setUncontrolledDraft((current) => ({ ...current, ...patch }));
    }
    onDraftChange?.(patch);
  };

  const showNav = !publishedVideo && step !== 'select' && step !== 'progress';
  const showContinue =
    !publishedVideo && (step === 'details' || step === 'thumbnail' || step === 'visibility');

  let body: ReactNode;
  switch (step) {
    case 'select':
      body = (
        <SelectVideoStep
          {...(fileName !== undefined ? { fileName } : {})}
          {...(fileSize !== undefined ? { fileSize } : {})}
          {...(fileError !== undefined ? { error: fileError } : {})}
          {...(onFileSelect ? { onFileSelect } : {})}
        />
      );
      break;
    case 'progress':
      body = (
        <UploadProgressStep
          {...(fileName !== undefined ? { fileName } : {})}
          {...(uploadStatus !== undefined ? { status: uploadStatus } : {})}
          {...(progress !== undefined ? { progress } : {})}
          {...(uploadError !== undefined ? { error: uploadError } : {})}
          {...(uploadErrorKind !== undefined ? { errorKind: uploadErrorKind } : {})}
          {...(onCancelUpload ? { onCancel: onCancelUpload } : {})}
          {...(onRetryUpload ? { onRetry: onRetryUpload } : {})}
          {...(onEditDraftFromUpload ? { onEditDraft: onEditDraftFromUpload } : {})}
          {...(mediaAsset !== undefined ? { mediaAsset } : {})}
          {...(mediaPreviewSrc !== undefined ? { mediaPreviewSrc } : {})}
          {...(isRemovingMedia !== undefined ? { isRemovingMedia } : {})}
          {...(removeMediaError !== undefined ? { removeMediaError } : {})}
          {...(onRemoveMedia ? { onRemoveMedia } : {})}
        />
      );
      break;
    case 'details':
      body = (
        <div className="space-y-5">
          {fileName && !mediaAsset && (
            <div className="space-y-1" role="status">
              <Text size="sm">
                Selected: {fileName}
                {fileSize !== undefined ? ` (${formatBytes(fileSize)})` : ''}
              </Text>
              <Text
                size="sm"
                tone={fileError ? 'danger' : 'muted'}
                {...(fileError ? { role: 'alert' } : {})}
              >
                {fileError ??
                  'Save your draft before uploading. Complete the required details, then save to start the upload.'}
              </Text>
            </div>
          )}
          {mediaAsset && (
            <AttachedMediaAsset
              asset={mediaAsset}
              {...(mediaPreviewSrc !== undefined ? { previewSrc: mediaPreviewSrc } : {})}
              {...(isRemovingMedia !== undefined ? { isRemoving: isRemovingMedia } : {})}
              {...(removeMediaError !== undefined ? { removeError: removeMediaError } : {})}
              {...(onRemoveMedia ? { onRemove: onRemoveMedia } : {})}
            />
          )}
          <VideoDetailsStep
            value={stepDetails(draft)}
            {...(detailsErrors !== undefined ? { errors: detailsErrors } : {})}
            onChange={patchDraft}
          />
        </div>
      );
      break;
    case 'thumbnail':
      body = (
        <ThumbnailStep
          autoThumbnails={autoThumbnails}
          selectedUrl={draft.thumbnailUrl}
          {...(customThumbnailUrl !== undefined ? { customPreviewUrl: customThumbnailUrl } : {})}
          {...(thumbnailError !== undefined ? { error: thumbnailError } : {})}
          onSelectAuto={(url) => {
            if (
              url.trim().toLowerCase().startsWith('blob:') ||
              url.trim().toLowerCase().startsWith('data:')
            ) {
              return;
            }
            patchDraft({ thumbnailUrl: url });
          }}
          {...(onCustomThumbnailSelect ? { onCustomFileSelect: onCustomThumbnailSelect } : {})}
        />
      );
      break;
    case 'visibility':
      body = (
        <VisibilityStep
          value={draft.visibility}
          {...(visibilityError !== undefined ? { error: visibilityError } : {})}
          onChange={(visibility) => patchDraft({ visibility })}
        />
      );
      break;
    case 'publish':
      body = (
        <PublishConfirmationStep
          details={stepDetails(draft)}
          visibility={draft.visibility}
          {...(draft.thumbnailUrl ? { thumbnailUrl: draft.thumbnailUrl } : {})}
          {...(fileName !== undefined ? { fileName } : {})}
          {...(mediaAsset !== undefined ? { mediaAsset } : {})}
          {...(isPublishing !== undefined ? { isPublishing } : {})}
          {...(isSavingDraft !== undefined ? { isSavingDraft } : {})}
          {...(isUnpublishing !== undefined ? { isUnpublishing } : {})}
          {...(publishError !== undefined ? { publishError } : {})}
          {...(publishedVideo !== undefined ? { publishedVideo } : {})}
          {...(shareUrl !== undefined ? { shareUrl } : {})}
          {...(publishApproval !== undefined ? { publishApproval } : {})}
          {...(publishActionLabel !== undefined ? { publishActionLabel } : {})}
          {...(onPublish ? { onPublish } : {})}
          {...(onSaveDraft ? { onSaveDraft } : {})}
          {...(onUnpublish ? { onUnpublish } : {})}
          {...(onWatch ? { onWatch } : {})}
          {...(onUploadAnother ? { onUploadAnother } : {})}
        />
      );
      break;
  }

  const content = (
    <div data-theme={theme} className={cx(theme === 'dark' && 'dark', className)}>
      <Page title="Upload" description="Share a new video with your audience." containerSize="lg">
        <div className="space-y-8">
          {!publishedVideo && (
            <UploadStepper
              activeStep={step}
              completedSteps={completedSteps}
              onStepSelect={(next) => {
                if (canNavigateToUploadStep({ target: next, activeStep: step, completedSteps })) {
                  setStep(next);
                }
              }}
            />
          )}
          <section
            {...(publishedVideo
              ? { 'aria-label': 'Publish confirmation' }
              : { 'aria-labelledby': stepHeadingId })}
            className="rounded-lg border border-border bg-surface p-4 sm:p-6"
          >
            {!publishedVideo && (
              <Heading id={stepHeadingId} as="h2" size="sm" className="mb-5">
                {uploadStepLabels[step]}
              </Heading>
            )}
            {body}
          </section>
          {(showNav || showContinue) && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                {canGoBack(step, uploadStatus) && onBack && (
                  <Button type="button" variant="ghost" onClick={onBack}>
                    Back
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {showContinue && onContinue && (
                  <Button type="button" onClick={onContinue}>
                    Next
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </Page>
    </div>
  );

  if (shell) {
    return <AppShell {...shell}>{content}</AppShell>;
  }
  return content;
}
