'use client';

import type { VideoApiClient } from '@w3ds/api-client';
import type { ChannelId, Video, VideoCategory, VideoLanguage, VideoVisibility } from '@w3ds/types';
import { useEffect, useRef, useState } from 'react';
import type { UploadProgressStatus, UploadProgressView } from './steps/upload-progress-step';
import { titleFromFileName, type UploadStepId, uploadStepOrder } from './upload-constants';
import {
  emptyUploadDraft,
  type UploadDraft,
  UploadPage,
  type UploadPageProps,
} from './upload-page';
import {
  hasDetailsErrors,
  type UploadDetailsErrors,
  validateDetails,
  validateThumbnailFile,
  validateThumbnailSelection,
  validateVideoFile,
  validateVisibility,
} from './upload-validation';

export interface UploadPageDataProps
  extends Omit<
    UploadPageProps,
    | 'step'
    | 'onStepChange'
    | 'completedSteps'
    | 'fileName'
    | 'fileSize'
    | 'fileError'
    | 'onFileSelect'
    | 'uploadStatus'
    | 'progress'
    | 'uploadError'
    | 'onCancelUpload'
    | 'onRetryUpload'
    | 'draft'
    | 'onDraftChange'
    | 'detailsErrors'
    | 'thumbnailError'
    | 'visibilityError'
    | 'autoThumbnails'
    | 'customThumbnailUrl'
    | 'onCustomThumbnailSelect'
    | 'isPublishing'
    | 'publishError'
    | 'publishedVideo'
    | 'onPublish'
    | 'onContinue'
    | 'onBack'
  > {
  client: VideoApiClient;
  channelId: ChannelId;
  onWatchVideo?: (video: Video) => void;
}

function previousStep(step: UploadStepId): UploadStepId | undefined {
  const index = uploadStepOrder.indexOf(step);
  return index > 0 ? uploadStepOrder[index - 1] : undefined;
}

function nextStep(step: UploadStepId): UploadStepId | undefined {
  const index = uploadStepOrder.indexOf(step);
  return index >= 0 && index < uploadStepOrder.length - 1 ? uploadStepOrder[index + 1] : undefined;
}

export function UploadPageData({
  client,
  channelId,
  onWatchVideo,
  onWatch,
  onUploadAnother,
  ...pageProps
}: UploadPageDataProps) {
  const [step, setStep] = useState<UploadStepId>('select');
  const [completedSteps, setCompletedSteps] = useState<UploadStepId[]>([]);
  const [file, setFile] = useState<File | undefined>();
  const [fileError, setFileError] = useState<string | undefined>();
  const [uploadStatus, setUploadStatus] = useState<UploadProgressStatus>('uploading');
  const [progress, setProgress] = useState<UploadProgressView | undefined>();
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [uploadId, setUploadId] = useState<string | undefined>();
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>();
  const [autoThumbnails, setAutoThumbnails] = useState<readonly string[]>([]);
  const [customThumbnailUrl, setCustomThumbnailUrl] = useState<string | undefined>();
  const [draft, setDraft] = useState<UploadDraft>(emptyUploadDraft);
  const [detailsErrors, setDetailsErrors] = useState<UploadDetailsErrors | undefined>();
  const [thumbnailError, setThumbnailError] = useState<string | undefined>();
  const [visibilityError, setVisibilityError] = useState<string | undefined>();
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | undefined>();
  const [publishedVideo, setPublishedVideo] = useState<Video | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const customObjectUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (customObjectUrlRef.current) URL.revokeObjectURL(customObjectUrlRef.current);
    };
  }, []);

  const markCompleted = (completed: UploadStepId) => {
    setCompletedSteps((current) =>
      current.includes(completed) ? current : [...current, completed],
    );
  };

  const patchDraft = (patch: Partial<UploadDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const resetFlow = () => {
    abortRef.current?.abort();
    abortRef.current = undefined;
    if (customObjectUrlRef.current) {
      URL.revokeObjectURL(customObjectUrlRef.current);
      customObjectUrlRef.current = undefined;
    }
    setStep('select');
    setCompletedSteps([]);
    setFile(undefined);
    setFileError(undefined);
    setUploadStatus('uploading');
    setProgress(undefined);
    setUploadError(undefined);
    setUploadId(undefined);
    setDurationSeconds(undefined);
    setAutoThumbnails([]);
    setCustomThumbnailUrl(undefined);
    setDraft(emptyUploadDraft());
    setDetailsErrors(undefined);
    setThumbnailError(undefined);
    setVisibilityError(undefined);
    setIsPublishing(false);
    setPublishError(undefined);
    setPublishedVideo(undefined);
  };

  const startUpload = async (nextFile: File) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setUploadStatus('uploading');
    setUploadError(undefined);
    setProgress({
      percent: 0,
      bytesUploaded: 0,
      bytesTotal: nextFile.size,
      bytesPerSecond: 0,
      remainingSeconds: Number.POSITIVE_INFINITY,
    });
    setStep('progress');

    try {
      const result = await client.uploadVideo(
        { name: nextFile.name, size: nextFile.size, type: nextFile.type },
        {
          signal: controller.signal,
          onProgress: setProgress,
        },
      );
      if (controller.signal.aborted) return;
      setUploadId(result.uploadId);
      setDurationSeconds(result.durationSeconds);
      setAutoThumbnails(result.autoThumbnails);
      setUploadStatus('complete');
      setProgress((current) =>
        current
          ? { ...current, percent: 100, bytesUploaded: current.bytesTotal, remainingSeconds: 0 }
          : current,
      );
      markCompleted('select');
      markCompleted('progress');
      patchDraft({
        title: titleFromFileName(result.fileName),
        thumbnailUrl: result.autoThumbnails[0] ?? '',
      });
      setStep('details');
    } catch (reason) {
      if (
        controller.signal.aborted ||
        (reason instanceof DOMException && reason.name === 'AbortError')
      ) {
        setUploadStatus('cancelled');
        setUploadError('Upload cancelled.');
        return;
      }
      setUploadStatus('error');
      setUploadError(reason instanceof Error ? reason.message : 'Upload failed.');
    }
  };

  const onFileSelect = (nextFile: File) => {
    const error = validateVideoFile(nextFile);
    setFileError(error);
    if (error) return;
    setFile(nextFile);
    void startUpload(nextFile);
  };

  const onCancelUpload = () => {
    abortRef.current?.abort();
    setUploadStatus('cancelled');
    setUploadError('Upload cancelled.');
  };

  const onRetryUpload = () => {
    if (!file) {
      setStep('select');
      return;
    }
    void startUpload(file);
  };

  const onCustomThumbnailSelect = (image: File) => {
    const error = validateThumbnailFile(image);
    setThumbnailError(error);
    if (error) return;
    if (customObjectUrlRef.current) URL.revokeObjectURL(customObjectUrlRef.current);
    const objectUrl = URL.createObjectURL(image);
    customObjectUrlRef.current = objectUrl;
    setCustomThumbnailUrl(objectUrl);
    patchDraft({ thumbnailUrl: objectUrl });
  };

  const validateCurrentStep = (): boolean => {
    if (step === 'details') {
      const errors = validateDetails({
        title: draft.title,
        description: draft.description,
        tags: draft.tags,
        category: draft.category,
        language: draft.language,
      });
      setDetailsErrors(errors);
      return !hasDetailsErrors(errors);
    }
    if (step === 'thumbnail') {
      const error = validateThumbnailSelection({ thumbnailUrl: draft.thumbnailUrl });
      setThumbnailError(error);
      return !error;
    }
    if (step === 'visibility') {
      const error = validateVisibility({ visibility: draft.visibility });
      setVisibilityError(error);
      return !error;
    }
    return true;
  };

  const onContinue = () => {
    if (!validateCurrentStep()) return;
    markCompleted(step);
    const next = nextStep(step);
    if (next) setStep(next);
  };

  const onBack = () => {
    const previous = previousStep(step);
    if (previous) setStep(previous);
  };

  const onPublish = async () => {
    if (!uploadId || !draft.category || !draft.language || !draft.visibility) {
      setPublishError('Complete all required fields before publishing.');
      return;
    }
    if (!validateCurrentStep()) return;
    const detailsOk = !hasDetailsErrors(
      validateDetails({
        title: draft.title,
        description: draft.description,
        tags: draft.tags,
        category: draft.category,
        language: draft.language,
      }),
    );
    const thumbnailOk = !validateThumbnailSelection({ thumbnailUrl: draft.thumbnailUrl });
    const visibilityOk = !validateVisibility({ visibility: draft.visibility });
    if (!detailsOk || !thumbnailOk || !visibilityOk) {
      setPublishError('Complete all required fields before publishing.');
      return;
    }

    setIsPublishing(true);
    setPublishError(undefined);
    try {
      const video = await client.createVideo({
        channelId,
        uploadId,
        title: draft.title,
        description: draft.description,
        tags: draft.tags,
        category: draft.category as VideoCategory,
        language: draft.language as VideoLanguage,
        visibility: draft.visibility as VideoVisibility,
        thumbnailUrl: draft.thumbnailUrl,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        status: 'published',
      });
      markCompleted('details');
      markCompleted('thumbnail');
      markCompleted('visibility');
      markCompleted('publish');
      setPublishedVideo(video);
    } catch (reason) {
      setPublishError(reason instanceof Error ? reason.message : 'Could not publish this video.');
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <UploadPage
      {...pageProps}
      step={step}
      onStepChange={setStep}
      completedSteps={completedSteps}
      {...(file ? { fileName: file.name, fileSize: file.size } : {})}
      {...(fileError !== undefined ? { fileError } : {})}
      onFileSelect={onFileSelect}
      uploadStatus={uploadStatus}
      {...(progress !== undefined ? { progress } : {})}
      {...(uploadError !== undefined ? { uploadError } : {})}
      onCancelUpload={onCancelUpload}
      onRetryUpload={onRetryUpload}
      draft={draft}
      onDraftChange={patchDraft}
      {...(detailsErrors !== undefined ? { detailsErrors } : {})}
      {...(thumbnailError !== undefined ? { thumbnailError } : {})}
      {...(visibilityError !== undefined ? { visibilityError } : {})}
      autoThumbnails={autoThumbnails}
      {...(customThumbnailUrl !== undefined ? { customThumbnailUrl } : {})}
      onCustomThumbnailSelect={onCustomThumbnailSelect}
      isPublishing={isPublishing}
      {...(publishError !== undefined ? { publishError } : {})}
      {...(publishedVideo !== undefined ? { publishedVideo } : {})}
      onPublish={() => {
        void onPublish();
      }}
      onWatch={(video) => {
        onWatch?.(video);
        onWatchVideo?.(video);
      }}
      onUploadAnother={() => {
        resetFlow();
        onUploadAnother?.();
      }}
      onContinue={onContinue}
      onBack={onBack}
    />
  );
}
