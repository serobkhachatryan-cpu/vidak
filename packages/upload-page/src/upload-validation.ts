import type { VideoCategory, VideoLanguage, VideoVisibility } from '@w3ds/types';
import {
  maxThumbnailFileSizeBytes,
  maxVideoFileSizeBytes,
  supportedThumbnailMimeTypes,
  supportedVideoExtensions,
  supportedVideoMimeTypes,
} from './upload-constants';

export interface UploadFileLike {
  name: string;
  size: number;
  type: string;
}

export interface UploadDetailsInput {
  title: string;
  description: string;
  tags: readonly string[];
  category: VideoCategory | '';
  language: VideoLanguage | '';
}

export interface UploadDetailsErrors {
  title?: string;
  description?: string;
  category?: string;
  language?: string;
  tags?: string;
}

export interface ThumbnailSelectionInput {
  thumbnailUrl: string;
}

export interface VisibilitySelectionInput {
  visibility: VideoVisibility | '';
}

function hasSupportedVideoType(file: UploadFileLike): boolean {
  if ((supportedVideoMimeTypes as readonly string[]).includes(file.type)) return true;
  const lower = file.name.toLocaleLowerCase();
  return supportedVideoExtensions.some((extension) => lower.endsWith(extension));
}

function hasSupportedThumbnailType(file: UploadFileLike): boolean {
  return (supportedThumbnailMimeTypes as readonly string[]).includes(file.type);
}

export function validateVideoFile(file: UploadFileLike | undefined): string | undefined {
  if (!file) return 'Select a video file to upload.';
  if (!hasSupportedVideoType(file)) {
    return `Unsupported format. Use ${supportedVideoExtensions.join(', ')}.`;
  }
  if (file.size <= 0) return 'The selected file is empty.';
  if (file.size > maxVideoFileSizeBytes) {
    return `File is too large. Maximum size is ${Math.round(maxVideoFileSizeBytes / (1024 * 1024 * 1024))} GB.`;
  }
  return undefined;
}

export function validateThumbnailFile(file: UploadFileLike | undefined): string | undefined {
  if (!file) return 'Select an image file.';
  if (!hasSupportedThumbnailType(file)) {
    return 'Unsupported thumbnail format. Use JPG, PNG, or WebP.';
  }
  if (file.size <= 0) return 'The selected thumbnail is empty.';
  if (file.size > maxThumbnailFileSizeBytes) {
    return 'Thumbnail is too large. Maximum size is 5 MB.';
  }
  return undefined;
}

export function validateDetails(input: UploadDetailsInput): UploadDetailsErrors {
  const errors: UploadDetailsErrors = {};
  if (!input.title.trim()) errors.title = 'Title is required.';
  else if (input.title.trim().length > 100) errors.title = 'Title must be 100 characters or fewer.';
  if (input.description.length > 5000) {
    errors.description = 'Description must be 5,000 characters or fewer.';
  }
  if (!input.category) errors.category = 'Category is required.';
  if (!input.language) errors.language = 'Language is required.';
  if (input.tags.length > 20) errors.tags = 'You can add up to 20 tags.';
  return errors;
}

export function hasDetailsErrors(errors: UploadDetailsErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function validateThumbnailSelection(input: ThumbnailSelectionInput): string | undefined {
  if (!input.thumbnailUrl.trim()) return 'Select or upload a thumbnail.';
  return undefined;
}

export function validateVisibility(input: VisibilitySelectionInput): string | undefined {
  if (!input.visibility) return 'Choose a visibility option.';
  return undefined;
}

export interface PublishDraftInput extends UploadDetailsInput, ThumbnailSelectionInput {
  visibility: VideoVisibility | '';
  uploadId?: string | undefined;
}

/** Final gate before createVideo — details, thumbnail, visibility, and a finished upload. */
export function validatePublishDraft(input: PublishDraftInput): string | undefined {
  if (!input.uploadId) return 'Complete all required fields before publishing.';
  if (hasDetailsErrors(validateDetails(input))) {
    return 'Complete all required fields before publishing.';
  }
  if (validateThumbnailSelection(input) || validateVisibility(input)) {
    return 'Complete all required fields before publishing.';
  }
  return undefined;
}

/** Final gate before saving editable draft metadata (not publishing). */
export function validateSaveDraft(input: PublishDraftInput): string | undefined {
  if (hasDetailsErrors(validateDetails(input))) {
    return 'Complete all required fields before saving this draft.';
  }
  if (validateThumbnailSelection(input) || validateVisibility(input)) {
    return 'Complete all required fields before saving this draft.';
  }
  return undefined;
}
