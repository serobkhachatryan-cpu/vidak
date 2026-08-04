import type { VideoCategory, VideoLanguage, VideoVisibility } from '@w3ds/types';
import { videoCategories, videoLanguages } from '@w3ds/types';

export const uploadStepOrder = [
  'select',
  'progress',
  'details',
  'thumbnail',
  'visibility',
  'publish',
] as const;

export type UploadStepId = (typeof uploadStepOrder)[number];

export const uploadStepLabels: Record<UploadStepId, string> = {
  select: 'Select video',
  progress: 'Upload',
  details: 'Details',
  thumbnail: 'Thumbnail',
  visibility: 'Visibility',
  publish: 'Publish',
};

export const supportedVideoMimeTypes = ['video/mp4', 'video/webm', 'video/quicktime'] as const;

export const supportedVideoExtensions = ['.mp4', '.webm', '.mov'] as const;

/** 2 GB ceiling for creator uploads in the product UI. */
export const maxVideoFileSizeBytes = 2 * 1024 * 1024 * 1024;

export const supportedThumbnailMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const maxThumbnailFileSizeBytes = 5 * 1024 * 1024;

export const videoCategoryLabels: Record<VideoCategory, string> = {
  entertainment: 'Entertainment',
  education: 'Education',
  gaming: 'Gaming',
  music: 'Music',
  science_technology: 'Science & Technology',
  howto: 'Howto & Style',
  sports: 'Sports',
  news: 'News & Politics',
  travel: 'Travel & Events',
  people_blogs: 'People & Blogs',
  comedy: 'Comedy',
  film_animation: 'Film & Animation',
};

export const videoLanguageLabels: Record<VideoLanguage, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  ar: 'Arabic',
  hi: 'Hindi',
};

export const visibilityLabels: Record<VideoVisibility, string> = {
  public: 'Public',
  unlisted: 'Unlisted',
  private: 'Private',
};

export const visibilityDescriptions: Record<VideoVisibility, string> = {
  public: 'Anyone can search for and watch this video.',
  unlisted: 'Anyone with the link can watch. It will not appear in search.',
  private: 'Only you can watch this video.',
};

export const videoCategoryOptions = videoCategories.map((value) => ({
  value,
  label: videoCategoryLabels[value],
}));

export const videoLanguageOptions = videoLanguages.map((value) => ({
  value,
  label: videoLanguageLabels[value],
}));

export const visibilityOptions = (['public', 'unlisted', 'private'] as const).map((value) => ({
  value,
  label: visibilityLabels[value],
  description: visibilityDescriptions[value],
}));

export function titleFromFileName(fileName: string): string {
  const base = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!base) return 'Untitled video';
  return base.replace(/\b\w/g, (char) => char.toLocaleUpperCase());
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatRemainingTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Calculating…';
  if (seconds < 1) return 'Less than a second';
  if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.ceil(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s remaining`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m remaining`;
}
