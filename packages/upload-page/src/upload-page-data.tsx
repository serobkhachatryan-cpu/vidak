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
import { normalizePersistedThumbnailUrl } from '@w3ds/types';
import { useEffect, useRef, useState } from 'react';
import {
  buildCreateDraftInput,
  DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE,
  DRAFT_SAVE_FAILED_MESSAGE,
  DraftUploadError,
  gateDraftCreateForUpload,
  isDraftUploadError,
} from './draft-before-upload';
import { resolveVideoContentType } from './resolve-video-content-type';
import type {
  UploadProgressErrorKind,
  UploadProgressStatus,
  UploadProgressView,
} from './steps/upload-progress-step';
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
import { createGeneratedVideoThumbnail } from './video-thumbnail';

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
    | 'uploadErrorKind'
    | 'onCancelUpload'
    | 'onRetryUpload'
    | 'onEditDraftFromUpload'
    | 'mediaAsset'
    | 'mediaPreviewSrc'
    | 'isRemovingMedia'
    | 'removeMediaError'
    | 'onRemoveMedia'
    | 'draft'
    | 'onDraftChange'
    | 'restoreDraftError'
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
  /**
   * Lets a product require a creator approval before publishing without putting
   * its protocol details in this shared upload package.
   */
  requestPublishApproval?: (draft: Video) => Promise<Video>;
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
  requestPublishApproval,
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
  const [uploadErrorKind, setUploadErrorKind] = useState<UploadProgressErrorKind | undefined>();
  const [draftVideoId, setDraftVideoId] = useState<VideoId | undefined>(initialDraftId);
  const [mediaAsset, setMediaAsset] = useState<DraftMediaAsset | undefined>();
  const [isRemovingMedia, setIsRemovingMedia] = useState(false);
  const [removeMediaError, setRemoveMediaError] = useState<string | undefined>();
  const [autoThumbnails, setAutoThumbnails] = useState<readonly string[]>([]);
  const [customThumbnailUrl, setCustomThumbnailUrl] = useState<string | undefined>();
  const [draft, setDraft] = useState<UploadDraft>(emptyUploadDraft);
  const [restoreDraftError, setRestoreDraftError] = useState<string | undefined>();
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
  const draftCreateInFlightRef = useRef<Promise<VideoId> | undefined>(undefined);
  const mediaUploadInFlightRef = useRef<Promise<void> | undefined>(undefined);
  const uploadEpochRef = useRef(0);
  const thumbnailGenerationEpochRef = useRef(0);
  const draftRef = useRef(draft);
  const fileRef = useRef(file);
  const mediaAssetRef = useRef(mediaAsset);

  useEffect(() => {
    draftVideoIdRef.current = draftVideoId;
  }, [draftVideoId]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  useEffect(() => {
    mediaAssetRef.current = mediaAsset;
  }, [mediaAsset]);

  useEffect(() => {
    const videoId = initialDraftId?.trim();
    if (!videoId) return;
    let active = true;

    void Promise.all([client.getDraft(videoId), client.listDraftMedia(videoId)])
      .then(([savedDraft, assets]) => {
        if (!active) return;
        const primaryAsset = assets
          .filter((asset) => asset.uploadState === 'ready')
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
        draftVideoIdRef.current = savedDraft.id;
        setDraftVideoId(savedDraft.id);
        setDraft({
          title: savedDraft.title,
          description: savedDraft.description,
          tags: savedDraft.tags,
          category: savedDraft.category ?? '',
          language: savedDraft.language ?? '',
          visibility: savedDraft.visibility,
          thumbnailUrl: normalizePersistedThumbnailUrl(savedDraft.thumbnailUrl),
        });
        setMediaAsset(primaryAsset);
        setAutoThumbnails(savedDraft.thumbnailUrl ? [savedDraft.thumbnailUrl] : []);
        setUploadStatus(primaryAsset ? 'complete' : 'idle');
        setCompletedSteps(primaryAsset ? ['select', 'progress'] : []);
        setRestoreDraftError(undefined);
        setStep('details');
      })
      .catch(() => {
        if (active) {
          setRestoreDraftError('Could not open this saved video. Refresh and try again.');
        }
      });

    return () => {
      active = false;
    };
  }, [client, initialDraftId]);

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

  const clearUploadFailure = () => {
    setUploadError(undefined);
    setUploadErrorKind(undefined);
  };

  const resetFlow = () => {
    abortRef.current?.abort();
    abortRef.current = undefined;
    draftCreateInFlightRef.current = undefined;
    mediaUploadInFlightRef.current = undefined;
    uploadEpochRef.current += 1;
    thumbnailGenerationEpochRef.current += 1;
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
    clearUploadFailure();
    draftVideoIdRef.current = undefined;
    setDraftVideoId(undefined);
    setMediaAsset(undefined);
    setIsRemovingMedia(false);
    setRemoveMediaError(undefined);
    setAutoThumbnails([]);
    setCustomThumbnailUrl(undefined);
    setDraft(emptyUploadDraft());
    setRestoreDraftError(undefined);
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
    ...(draft.language ? { language: draft.language as VideoLanguage } : {}),
    visibility: draft.visibility as VideoVisibility,
    thumbnailUrl: normalizePersistedThumbnailUrl(draft.thumbnailUrl),
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

  /**
   * Ensures a durable draft ID exists before any media upload.
   * Deduplicates concurrent create calls; never invents a media call without an ID.
   */
  const ensureSavedDraft = async (nextFile: File, draftSnapshot: UploadDraft): Promise<VideoId> => {
    if (draftVideoIdRef.current) return draftVideoIdRef.current;
    if (draftCreateInFlightRef.current) return draftCreateInFlightRef.current;

    const gate = gateDraftCreateForUpload({
      fileName: nextFile.name,
      draftTitle: draftSnapshot.title,
    });
    if (!gate.ok) {
      throw new DraftUploadError('draft_required', DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE);
    }

    let pending!: Promise<VideoId>;
    pending = (async () => {
      try {
        const video = await client.createDraft(buildCreateDraftInput(gate.title, draftSnapshot));
        draftVideoIdRef.current = video.id;
        setDraftVideoId(video.id);
        if (!draftSnapshot.title.trim()) {
          patchDraft({ title: gate.title });
        }
        return video.id;
      } catch (cause) {
        if (isDraftUploadError(cause)) throw cause;
        throw new DraftUploadError('draft_save_failed', DRAFT_SAVE_FAILED_MESSAGE, { cause });
      } finally {
        if (draftCreateInFlightRef.current === pending) {
          draftCreateInFlightRef.current = undefined;
        }
      }
    })();

    draftCreateInFlightRef.current = pending;
    return pending;
  };

  const beginMediaUpload = async (
    nextFile: File,
    videoId: VideoId,
    epoch: number,
  ): Promise<void> => {
    if (!videoId) {
      throw new DraftUploadError('draft_required', DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE);
    }
    if (mediaUploadInFlightRef.current) return mediaUploadInFlightRef.current;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let pending!: Promise<void>;
    pending = (async () => {
      try {
        if (uploadEpochRef.current !== epoch) return;
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
        if (controller.signal.aborted || uploadEpochRef.current !== epoch) return;

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
            title: draftRef.current.title.trim() || titleFromFileName(asset.originalFilename),
            thumbnailUrl: draftRef.current.thumbnailUrl || mockUploadAutoThumbnails[0] || '',
          });
        } else {
          setAutoThumbnails([]);
          patchDraft({
            title: draftRef.current.title.trim() || titleFromFileName(asset.originalFilename),
          });

          const generationEpoch = thumbnailGenerationEpochRef.current + 1;
          thumbnailGenerationEpochRef.current = generationEpoch;
          void (async () => {
            try {
              const previewImage = await createGeneratedVideoThumbnail(
                client.draftMediaContentPath(videoId, asset.id),
                asset.originalFilename,
              );
              if (thumbnailGenerationEpochRef.current !== generationEpoch) return;
              const video = await client.uploadDraftThumbnail(videoId, {
                name: previewImage.name,
                size: previewImage.size,
                type: previewImage.type,
                body: previewImage,
              });
              if (thumbnailGenerationEpochRef.current !== generationEpoch) return;
              const thumbnailUrl = normalizePersistedThumbnailUrl(video.thumbnailUrl);
              if (!thumbnailUrl) return;
              setAutoThumbnails([thumbnailUrl]);
              if (!draftRef.current.thumbnailUrl.trim()) patchDraft({ thumbnailUrl });
            } catch {
              // A browser may not decode every valid upload. Never block the creator on a preview.
            }
          })();
        }
        setStep('details');
      } finally {
        if (mediaUploadInFlightRef.current === pending) {
          mediaUploadInFlightRef.current = undefined;
        }
      }
    })();

    mediaUploadInFlightRef.current = pending;
    return pending;
  };

  const deferUploadUntilDraftComplete = (nextFile: File, draftSnapshot: UploadDraft) => {
    const title =
      draftSnapshot.title.trim() || titleFromFileName(nextFile.name) || 'Untitled video';
    if (!draftSnapshot.title.trim()) {
      patchDraft({ title });
    }
    setUploadStatus('idle');
    setProgress(undefined);
    clearUploadFailure();
    setFileError(DRAFT_REQUIRED_BEFORE_UPLOAD_MESSAGE);
    setStep('details');
  };

  const isAbortFailure = (reason: unknown): boolean =>
    (reason instanceof DOMException && reason.name === 'AbortError') ||
    (reason instanceof Error && reason.name === 'AbortError');

  const startUpload = async (nextFile: File) => {
    if (mediaUploadInFlightRef.current) return;

    const draftSnapshot = draftRef.current;
    const gate = gateDraftCreateForUpload({
      fileName: nextFile.name,
      draftTitle: draftSnapshot.title,
    });

    // Required create fields missing and no existing draft → do not enter a retry loop.
    if (!draftVideoIdRef.current && !gate.ok) {
      deferUploadUntilDraftComplete(nextFile, draftSnapshot);
      return;
    }

    const epoch = uploadEpochRef.current + 1;
    uploadEpochRef.current = epoch;

    setUploadStatus('uploading');
    clearUploadFailure();
    setFileError(undefined);
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
      const videoId = await ensureSavedDraft(nextFile, draftSnapshot);
      if (uploadEpochRef.current !== epoch) {
        setUploadStatus('cancelled');
        setUploadError('Upload cancelled.');
        setUploadErrorKind(undefined);
        return;
      }
      await beginMediaUpload(nextFile, videoId, epoch);
    } catch (reason) {
      if (uploadEpochRef.current !== epoch || isAbortFailure(reason)) {
        setUploadStatus('cancelled');
        setUploadError('Upload cancelled.');
        setUploadErrorKind(undefined);
        return;
      }
      if (isDraftUploadError(reason) && reason.kind === 'draft_required') {
        deferUploadUntilDraftComplete(nextFile, draftSnapshot);
        return;
      }
      setUploadStatus('error');
      if (isDraftUploadError(reason) && reason.kind === 'draft_save_failed') {
        setUploadError(reason.message);
        setUploadErrorKind('draft');
        return;
      }
      setUploadError(reason instanceof Error ? reason.message : 'Upload failed.');
      setUploadErrorKind('media');
    }
  };

  const onFileSelect = (nextFile: File) => {
    setUploadStatus('validating');
    setFileError(undefined);
    clearUploadFailure();
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
    uploadEpochRef.current += 1;
    abortRef.current?.abort();
    mediaUploadInFlightRef.current = undefined;
    setUploadStatus('cancelled');
    setUploadError('Upload cancelled.');
    setUploadErrorKind(undefined);
  };

  const onRetryUpload = () => {
    const nextFile = fileRef.current;
    if (!nextFile) {
      setUploadStatus('idle');
      setStep('select');
      return;
    }
    // Existing durable draft → retry media only (never create a second draft).
    if (draftVideoIdRef.current) {
      void (async () => {
        const epoch = uploadEpochRef.current + 1;
        uploadEpochRef.current = epoch;
        setUploadStatus('uploading');
        clearUploadFailure();
        setProgress({
          percent: 0,
          bytesUploaded: 0,
          bytesTotal: nextFile.size,
          bytesPerSecond: 0,
          remainingSeconds: Number.POSITIVE_INFINITY,
        });
        setStep('progress');
        try {
          await beginMediaUpload(nextFile, draftVideoIdRef.current as VideoId, epoch);
        } catch (reason) {
          if (uploadEpochRef.current !== epoch || isAbortFailure(reason)) {
            setUploadStatus('cancelled');
            setUploadError('Upload cancelled.');
            setUploadErrorKind(undefined);
            return;
          }
          setUploadStatus('error');
          setUploadError(reason instanceof Error ? reason.message : 'Upload failed.');
          setUploadErrorKind('media');
        }
      })();
      return;
    }
    void startUpload(nextFile);
  };

  const onEditDraftFromUpload = () => {
    const nextFile = fileRef.current;
    if (nextFile) {
      deferUploadUntilDraftComplete(nextFile, draftRef.current);
      return;
    }
    setUploadStatus('idle');
    clearUploadFailure();
    setStep('details');
  };

  const onRemoveMedia = async () => {
    const videoId = draftVideoIdRef.current;
    if (!mediaAsset || !videoId) return;
    setIsRemovingMedia(true);
    setRemoveMediaError(undefined);
    try {
      await client.deleteDraftMedia(videoId, mediaAsset.id);
      revokeLocalPreview();
      thumbnailGenerationEpochRef.current += 1;
      setMediaAsset(undefined);
      setAutoThumbnails([]);
      patchDraft({ thumbnailUrl: '' });
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

  const onCustomThumbnailSelect = async (image: File) => {
    const error = validateThumbnailFile(image);
    setThumbnailError(error);
    if (error) return;
    if (customObjectUrlRef.current) URL.revokeObjectURL(customObjectUrlRef.current);
    const objectUrl = URL.createObjectURL(image);
    customObjectUrlRef.current = objectUrl;
    setCustomThumbnailUrl(objectUrl);

    const videoId = draftVideoIdRef.current;
    if (!videoId) {
      // Local preview only — never persist ephemeral blob:/data: URLs.
      setThumbnailError('Save your draft before uploading a thumbnail.');
      return;
    }

    setThumbnailError(undefined);
    try {
      const video = await client.uploadDraftThumbnail(videoId, {
        name: image.name,
        size: image.size,
        type: image.type,
        body: image,
      });
      patchDraft({ thumbnailUrl: video.thumbnailUrl });
    } catch (reason) {
      setThumbnailError(
        reason instanceof Error ? reason.message : 'Could not upload the thumbnail.',
      );
    }
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
      setFileError(undefined);

      // Durable draft ID now exists — start any waiting media upload exactly once.
      const pendingFile = fileRef.current;
      if (pendingFile && !mediaAssetRef.current && !mediaUploadInFlightRef.current) {
        const epoch = uploadEpochRef.current + 1;
        uploadEpochRef.current = epoch;
        setUploadStatus('uploading');
        clearUploadFailure();
        setProgress({
          percent: 0,
          bytesUploaded: 0,
          bytesTotal: pendingFile.size,
          bytesPerSecond: 0,
          remainingSeconds: Number.POSITIVE_INFINITY,
        });
        setStep('progress');
        try {
          await beginMediaUpload(pendingFile, video.id, epoch);
        } catch (uploadReason) {
          if (uploadEpochRef.current !== epoch || isAbortFailure(uploadReason)) {
            setUploadStatus('cancelled');
            setUploadError('Upload cancelled.');
            setUploadErrorKind(undefined);
          } else {
            setUploadStatus('error');
            setUploadError(uploadReason instanceof Error ? uploadReason.message : 'Upload failed.');
            setUploadErrorKind('media');
          }
        }
      }
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
      const video = requestPublishApproval
        ? await requestPublishApproval(draftVideo)
        : await client.publishVideo(draftVideo.id);
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
  // A restored draft has no browser File object, but it still needs its durable media name and size.
  const displayFileName = file?.name ?? mediaAsset?.originalFilename;
  const displayFileSize = file?.size ?? mediaAsset?.byteSize;

  return (
    <UploadPage
      {...pageProps}
      step={step}
      onStepChange={setStep}
      completedSteps={completedSteps}
      {...(displayFileName ? { fileName: displayFileName } : {})}
      {...(displayFileSize !== undefined ? { fileSize: displayFileSize } : {})}
      {...(fileError !== undefined ? { fileError } : {})}
      onFileSelect={onFileSelect}
      uploadStatus={uploadStatus}
      {...(progress !== undefined ? { progress } : {})}
      {...(uploadError !== undefined ? { uploadError } : {})}
      {...(uploadErrorKind !== undefined ? { uploadErrorKind } : {})}
      onCancelUpload={onCancelUpload}
      onRetryUpload={onRetryUpload}
      onEditDraftFromUpload={onEditDraftFromUpload}
      {...(mediaAsset !== undefined ? { mediaAsset } : {})}
      {...(mediaPreviewSrc !== undefined ? { mediaPreviewSrc } : {})}
      isRemovingMedia={isRemovingMedia}
      {...(removeMediaError !== undefined ? { removeMediaError } : {})}
      onRemoveMedia={() => {
        void onRemoveMedia();
      }}
      draft={draft}
      onDraftChange={patchDraft}
      {...(restoreDraftError !== undefined ? { restoreDraftError } : {})}
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
