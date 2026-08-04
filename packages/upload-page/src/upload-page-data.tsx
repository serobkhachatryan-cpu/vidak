'use client';

import {
  MockVideoApiClient,
  mockUploadAutoThumbnails,
  publicVideoWatchPath,
  type VideoApiClient,
} from '@w3ds/api-client';
import type {
  ChannelId,
  DraftMediaAsset,
  Video,
  VideoCategory,
  VideoId,
  VideoLanguage,
  VideoVisibility,
} from '@w3ds/types';
import { useEffect, useRef, useState } from 'react';
import { DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE } from './draft-before-upload';
import { resolveVideoContentType } from './resolve-video-content-type';
import type { UploadProgressStatus, UploadProgressView } from './steps/upload-progress-step';
import {
  nextUploadStep,
  previousUploadStep,
  titleFromFileName,
  type UploadStepId,
} from './upload-constants';
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
  validateSaveDraft,
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
    | 'mediaAsset'
    | 'mediaPreviewSrc'
    | 'isRemovingMedia'
    | 'removeMediaError'
    | 'onRemoveMedia'
    | 'draft'
    | 'onDraftChange'
    | 'detailsErrors'
    | 'thumbnailError'
    | 'visibilityError'
    | 'autoThumbnails'
    | 'customThumbnailUrl'
    | 'onCustomThumbnailSelect'
    | 'isPublishing'
    | 'isSavingDraft'
    | 'isUnpublishing'
    | 'publishError'
    | 'publishedVideo'
    | 'shareUrl'
    | 'onPublish'
    | 'onSaveDraft'
    | 'onUnpublish'
    | 'onContinue'
    | 'onBack'
  > {
  client: VideoApiClient;
  channelId: ChannelId;
  /** Optional existing saved draft to attach media to. */
  draftId?: VideoId;
  onWatchVideo?: (video: Video) => void;
}

function buildShareUrl(video: Video): string | undefined {
  if (
    video.status !== 'published' ||
    !video.publicVideoId ||
    (video.visibility !== 'public' && video.visibility !== 'unlisted')
  ) {
    return undefined;
  }
  const path = publicVideoWatchPath(video.publicVideoId);
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}

export function UploadPageData({
  client,
  channelId: _channelId,
  draftId: initialDraftId,
  onWatchVideo,
  onWatch,
  onUploadAnother,
  ...pageProps
}: UploadPageDataProps) {
  // Channel ownership is resolved by the draft API for W3DS; retained for callers/mock context.
  void _channelId;
  const [step, setStep] = useState<UploadStepId>('select');
  const [completedSteps, setCompletedSteps] = useState<UploadStepId[]>([]);
  const [file, setFile] = useState<File | undefined>();
  const [fileError, setFileError] = useState<string | undefined>();
  const [uploadStatus, setUploadStatus] = useState<UploadProgressStatus>('idle');
  const [progress, setProgress] = useState<UploadProgressView | undefined>();
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [draftVideoId, setDraftVideoId] = useState<VideoId | undefined>(initialDraftId);
  const [mediaAsset, setMediaAsset] = useState<DraftMediaAsset | undefined>();
  const [isRemovingMedia, setIsRemovingMedia] = useState(false);
  const [removeMediaError, setRemoveMediaError] = useState<string | undefined>();
  const [autoThumbnails, setAutoThumbnails] = useState<readonly string[]>([]);
  const [customThumbnailUrl, setCustomThumbnailUrl] = useState<string | undefined>();
  const [draft, setDraft] = useState<UploadDraft>(emptyUploadDraft);
  const [detailsErrors, setDetailsErrors] = useState<UploadDetailsErrors | undefined>();
  const [thumbnailError, setThumbnailError] = useState<string | undefined>();
  const [visibilityError, setVisibilityError] = useState<string | undefined>();
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isUnpublishing, setIsUnpublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | undefined>();
  const [publishedVideo, setPublishedVideo] = useState<Video | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const customObjectUrlRef = useRef<string | undefined>(undefined);
  const localPreviewUrlRef = useRef<string | undefined>(undefined);
  const draftVideoIdRef = useRef<VideoId | undefined>(initialDraftId);

  useEffect(() => {
    draftVideoIdRef.current = draftVideoId;
  }, [draftVideoId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (customObjectUrlRef.current) URL.revokeObjectURL(customObjectUrlRef.current);
      if (localPreviewUrlRef.current) URL.revokeObjectURL(localPreviewUrlRef.current);
    };
  }, []);

  const revokeLocalPreview = () => {
    if (localPreviewUrlRef.current) {
      URL.revokeObjectURL(localPreviewUrlRef.current);
      localPreviewUrlRef.current = undefined;
    }
  };

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
    revokeLocalPreview();
    setStep('select');
    setCompletedSteps([]);
    setFile(undefined);
    setFileError(undefined);
    setUploadStatus('idle');
    setProgress(undefined);
    setUploadError(undefined);
    draftVideoIdRef.current = initialDraftId;
    setDraftVideoId(initialDraftId);
    setMediaAsset(undefined);
    setIsRemovingMedia(false);
    setRemoveMediaError(undefined);
    setAutoThumbnails([]);
    setCustomThumbnailUrl(undefined);
    setDraft(emptyUploadDraft());
    setDetailsErrors(undefined);
    setThumbnailError(undefined);
    setVisibilityError(undefined);
    setIsPublishing(false);
    setIsSavingDraft(false);
    setIsUnpublishing(false);
    setPublishError(undefined);
    setPublishedVideo(undefined);
  };

  const draftMetadata = () => ({
    title: draft.title,
    description: draft.description,
    tags: draft.tags,
    category: draft.category as VideoCategory,
    language: draft.language as VideoLanguage,
    visibility: draft.visibility as VideoVisibility,
    thumbnailUrl: draft.thumbnailUrl,
  });

  const persistDraftMetadata = async (): Promise<Video> => {
    const metadata = draftMetadata();
    const existingId = draftVideoIdRef.current;
    const video = existingId
      ? await client.updateDraft(existingId, metadata)
      : await client.createDraft(metadata);
    if (!existingId) {
      draftVideoIdRef.current = video.id;
      setDraftVideoId(video.id);
    }
    return video;
  };

  const ensureSavedDraft = async (nextFile: File, draftSnapshot: UploadDraft): Promise<VideoId> => {
    if (draftVideoIdRef.current) return draftVideoIdRef.current;

    const title =
      draftSnapshot.title.trim() || titleFromFileName(nextFile.name) || 'Untitled video';

    try {
      const video = await client.createDraft({
        title,
        ...(draftSnapshot.description ? { description: draftSnapshot.description } : {}),
        ...(draftSnapshot.tags.length > 0 ? { tags: draftSnapshot.tags } : {}),
        ...(draftSnapshot.category ? { category: draftSnapshot.category as VideoCategory } : {}),
        ...(draftSnapshot.language ? { language: draftSnapshot.language as VideoLanguage } : {}),
        ...(draftSnapshot.visibility
          ? { visibility: draftSnapshot.visibility as VideoVisibility }
          : {}),
        ...(draftSnapshot.thumbnailUrl ? { thumbnailUrl: draftSnapshot.thumbnailUrl } : {}),
      });
      draftVideoIdRef.current = video.id;
      setDraftVideoId(video.id);
      if (!draftSnapshot.title.trim()) {
        patchDraft({ title });
      }
      return video.id;
    } catch {
      throw new Error(DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE);
    }
  };

  const startUpload = async (nextFile: File) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setUploadStatus('uploading');
    setUploadError(undefined);
    setRemoveMediaError(undefined);
    setProgress({
      percent: 0,
      bytesUploaded: 0,
      bytesTotal: nextFile.size,
      bytesPerSecond: 0,
      remainingSeconds: Number.POSITIVE_INFINITY,
    });
    setStep('progress');

    try {
      const videoId = await ensureSavedDraft(nextFile, draft);
      if (controller.signal.aborted) return;

      const contentType = resolveVideoContentType(nextFile);
      const asset = await client.uploadDraftMedia(
        videoId,
        {
          name: nextFile.name,
          size: nextFile.size,
          type: contentType,
          body: nextFile,
        },
        {
          signal: controller.signal,
          onProgress: setProgress,
        },
      );
      if (controller.signal.aborted) return;

      revokeLocalPreview();
      setMediaAsset(asset);
      setUploadStatus('complete');
      setProgress((current) =>
        current
          ? { ...current, percent: 100, bytesUploaded: current.bytesTotal, remainingSeconds: 0 }
          : current,
      );
      markCompleted('select');
      markCompleted('progress');
      if (client instanceof MockVideoApiClient) {
        setAutoThumbnails(mockUploadAutoThumbnails);
        patchDraft({
          title: draft.title.trim() || titleFromFileName(asset.originalFilename),
          thumbnailUrl: draft.thumbnailUrl || mockUploadAutoThumbnails[0] || '',
        });
      } else {
        setAutoThumbnails([]);
        patchDraft({
          title: draft.title.trim() || titleFromFileName(asset.originalFilename),
        });
      }
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
    setUploadStatus('validating');
    setFileError(undefined);
    setUploadError(undefined);
    const error = validateVideoFile(nextFile);
    if (error) {
      setFileError(error);
      setUploadStatus('idle');
      setStep('select');
      return;
    }
    revokeLocalPreview();
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
      setUploadStatus('idle');
      setStep('select');
      return;
    }
    void startUpload(file);
  };

  const onRemoveMedia = async () => {
    const videoId = draftVideoIdRef.current;
    if (!mediaAsset || !videoId) return;
    setIsRemovingMedia(true);
    setRemoveMediaError(undefined);
    try {
      await client.deleteDraftMedia(videoId, mediaAsset.id);
      revokeLocalPreview();
      setMediaAsset(undefined);
      setAutoThumbnails([]);
      setUploadStatus('idle');
      setProgress(undefined);
      setCompletedSteps((current) => current.filter((item) => item !== 'progress'));
    } catch (reason) {
      setRemoveMediaError(
        reason instanceof Error ? reason.message : 'Could not remove the attached media.',
      );
    } finally {
      setIsRemovingMedia(false);
    }
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
    const next = nextUploadStep(step);
    if (next) setStep(next);
  };

  const onBack = () => {
    const previous = previousUploadStep(step);
    if (previous) setStep(previous);
  };

  const onSaveDraft = async () => {
    const error = validateSaveDraft({
      title: draft.title,
      description: draft.description,
      tags: draft.tags,
      category: draft.category,
      language: draft.language,
      thumbnailUrl: draft.thumbnailUrl,
      visibility: draft.visibility,
    });
    if (error) {
      setPublishError(error);
      return;
    }

    setIsSavingDraft(true);
    setPublishError(undefined);
    try {
      const video = await persistDraftMetadata();
      markCompleted('details');
      markCompleted('thumbnail');
      markCompleted('visibility');
      markCompleted('publish');
      setPublishedVideo(video);
    } catch (reason) {
      setPublishError(reason instanceof Error ? reason.message : 'Could not save this draft.');
    } finally {
      setIsSavingDraft(false);
    }
  };

  const onPublish = async () => {
    const error = validateSaveDraft({
      title: draft.title,
      description: draft.description,
      tags: draft.tags,
      category: draft.category,
      language: draft.language,
      thumbnailUrl: draft.thumbnailUrl,
      visibility: draft.visibility,
    });
    if (error) {
      setPublishError(error);
      return;
    }
    if (mediaAsset?.uploadState !== 'ready') {
      setPublishError('Publishing requires a ready media asset.');
      return;
    }

    setIsPublishing(true);
    setPublishError(undefined);
    try {
      const draftVideo = await persistDraftMetadata();
      const video = await client.publishVideo(draftVideo.id);
      draftVideoIdRef.current = video.id;
      setDraftVideoId(video.id);
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

  const onUnpublish = async () => {
    const videoId = publishedVideo?.id ?? draftVideoIdRef.current;
    if (!videoId) return;
    setIsUnpublishing(true);
    setPublishError(undefined);
    try {
      const video = await client.unpublishVideo(videoId);
      setPublishedVideo(video);
    } catch (reason) {
      setPublishError(reason instanceof Error ? reason.message : 'Could not unpublish this video.');
    } finally {
      setIsUnpublishing(false);
    }
  };

  const mediaPreviewSrc =
    mediaAsset && draftVideoId && mediaAsset.uploadState === 'ready'
      ? client.draftMediaContentPath(draftVideoId, mediaAsset.id)
      : undefined;
  const shareUrl = publishedVideo ? buildShareUrl(publishedVideo) : undefined;

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
      {...(mediaAsset !== undefined ? { mediaAsset } : {})}
      {...(mediaPreviewSrc !== undefined ? { mediaPreviewSrc } : {})}
      isRemovingMedia={isRemovingMedia}
      {...(removeMediaError !== undefined ? { removeMediaError } : {})}
      onRemoveMedia={() => {
        void onRemoveMedia();
      }}
      draft={draft}
      onDraftChange={patchDraft}
      {...(detailsErrors !== undefined ? { detailsErrors } : {})}
      {...(thumbnailError !== undefined ? { thumbnailError } : {})}
      {...(visibilityError !== undefined ? { visibilityError } : {})}
      autoThumbnails={autoThumbnails}
      {...(customThumbnailUrl !== undefined ? { customThumbnailUrl } : {})}
      onCustomThumbnailSelect={onCustomThumbnailSelect}
      isPublishing={isPublishing}
      isSavingDraft={isSavingDraft}
      isUnpublishing={isUnpublishing}
      {...(publishError !== undefined ? { publishError } : {})}
      {...(publishedVideo !== undefined ? { publishedVideo } : {})}
      {...(shareUrl !== undefined ? { shareUrl } : {})}
      onPublish={() => {
        void onPublish();
      }}
      onSaveDraft={() => {
        void onSaveDraft();
      }}
      onUnpublish={() => {
        void onUnpublish();
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
