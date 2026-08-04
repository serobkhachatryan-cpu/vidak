import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DraftMediaAsset, Video } from '@w3ds/types';
import { emptyUploadDraft, UploadPage } from './upload-page';

const autoThumbnails = [
  'https://images.unsplash.com/photo-1558655146-d09347e92766?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1280&h=720&fit=crop',
  'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1280&h=720&fit=crop',
] as const;

const draft = {
  ...emptyUploadDraft(),
  title: 'Building a practical design system',
  description: 'A tour of the decisions that keep a design system useful as a product grows.',
  tags: ['design systems', 'frontend'],
  category: 'education' as const,
  language: 'en' as const,
  visibility: 'public' as const,
  thumbnailUrl: autoThumbnails[0],
};

const savedDraft: Video = {
  id: 'video-design-system',
  channelId: 'channel-studio',
  title: draft.title,
  description: draft.description,
  thumbnailUrl: draft.thumbnailUrl,
  durationSeconds: 0,
  status: 'draft',
  visibility: 'public',
  category: 'education',
  language: 'en',
  createdAt: '2026-08-04T09:30:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  tags: draft.tags,
};

const mediaAsset: DraftMediaAsset = {
  id: 'asset-design-system',
  ownerId: 'user-grace',
  videoId: 'video-design-system',
  originalFilename: 'design-system.mp4',
  contentType: 'video/mp4',
  byteSize: 100_000_000,
  uploadState: 'ready',
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
};

const progress = {
  percent: 58,
  bytesUploaded: 58_000_000,
  bytesTotal: 100_000_000,
  bytesPerSecond: 2_500_000,
  remainingSeconds: 17,
};

const meta = {
  title: 'Pages/Upload page',
  component: UploadPage,
  parameters: { layout: 'fullscreen' },
  args: {
    step: 'select',
    onFileSelect: () => undefined,
    onDraftChange: () => undefined,
    onContinue: () => undefined,
    onBack: () => undefined,
  },
} satisfies Meta<typeof UploadPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SelectVideo: Story = {};

export const SelectVideoInvalid: Story = {
  args: {
    fileError: 'Unsupported format. Use .mp4, .webm, .mov.',
  },
};

export const UploadIdle: Story = {
  args: {
    step: 'progress',
    uploadStatus: 'idle',
  },
};

export const UploadValidating: Story = {
  args: {
    step: 'progress',
    fileName: 'design-system.mp4',
    uploadStatus: 'validating',
  },
};

export const Uploading: Story = {
  args: {
    step: 'progress',
    fileName: 'design-system.mp4',
    fileSize: 100_000_000,
    uploadStatus: 'uploading',
    progress,
    completedSteps: ['select'],
    onCancelUpload: () => undefined,
  },
};

export const UploadComplete: Story = {
  args: {
    step: 'progress',
    fileName: 'design-system.mp4',
    fileSize: 100_000_000,
    uploadStatus: 'complete',
    progress: { ...progress, percent: 100, bytesUploaded: 100_000_000, remainingSeconds: 0 },
    mediaAsset,
    mediaPreviewSrc: '/api/videos/drafts/video-design-system/media/asset-design-system/content',
    completedSteps: ['select', 'progress'],
    onRemoveMedia: () => undefined,
  },
};

export const UploadFailed: Story = {
  args: {
    step: 'progress',
    fileName: 'design-system.mp4',
    uploadStatus: 'error',
    uploadError: 'Network connection lost.',
    completedSteps: ['select'],
    onRetryUpload: () => undefined,
  },
};

export const UploadValidationError: Story = {
  args: {
    step: 'select',
    fileError: 'File is too large. Maximum size is 2 GB.',
  },
};

export const UploadCancelled: Story = {
  args: {
    step: 'progress',
    fileName: 'design-system.mp4',
    uploadStatus: 'cancelled',
    uploadError: 'Upload cancelled.',
    completedSteps: ['select'],
    onRetryUpload: () => undefined,
  },
};

export const UploadRetry: Story = {
  args: {
    step: 'progress',
    fileName: 'design-system.mp4',
    uploadStatus: 'error',
    uploadError: 'Network connection lost.',
    completedSteps: ['select'],
    onRetryUpload: () => undefined,
  },
};

export const RemovingAttachedAsset: Story = {
  args: {
    step: 'details',
    fileName: 'design-system.mp4',
    draft,
    mediaAsset,
    mediaPreviewSrc: '/api/videos/drafts/video-design-system/media/asset-design-system/content',
    isRemovingMedia: true,
    completedSteps: ['select', 'progress'],
    onRemoveMedia: () => undefined,
  },
};

export const RemoveAttachedAssetError: Story = {
  args: {
    step: 'details',
    fileName: 'design-system.mp4',
    draft,
    mediaAsset,
    removeMediaError: 'Could not remove the attached media.',
    completedSteps: ['select', 'progress'],
    onRemoveMedia: () => undefined,
  },
};

export const VideoDetails: Story = {
  args: {
    step: 'details',
    fileName: 'design-system.mp4',
    draft,
    mediaAsset,
    mediaPreviewSrc: '/api/videos/drafts/video-design-system/media/asset-design-system/content',
    completedSteps: ['select', 'progress'],
    onRemoveMedia: () => undefined,
  },
};

export const VideoDetailsInvalid: Story = {
  args: {
    step: 'details',
    fileName: 'design-system.mp4',
    draft: emptyUploadDraft(),
    detailsErrors: {
      title: 'Title is required.',
      category: 'Category is required.',
      language: 'Language is required.',
    },
    completedSteps: ['select', 'progress'],
  },
};

export const Thumbnail: Story = {
  args: {
    step: 'thumbnail',
    draft,
    autoThumbnails,
    completedSteps: ['select', 'progress', 'details'],
    onCustomThumbnailSelect: () => undefined,
  },
};

export const Visibility: Story = {
  args: {
    step: 'visibility',
    draft,
    completedSteps: ['select', 'progress', 'details', 'thumbnail'],
  },
};

export const DraftReview: Story = {
  args: {
    step: 'publish',
    fileName: 'design-system.mp4',
    draft,
    completedSteps: ['select', 'progress', 'details', 'thumbnail', 'visibility'],
    onPublish: () => undefined,
  },
};

export const DraftSaved: Story = {
  args: {
    step: 'publish',
    draft,
    publishedVideo: savedDraft,
    completedSteps: ['select', 'progress', 'details', 'thumbnail', 'visibility', 'publish'],
    onUploadAnother: () => undefined,
  },
};

export const Dark: Story = {
  args: {
    step: 'details',
    draft,
    theme: 'dark',
    completedSteps: ['select', 'progress'],
  },
};
