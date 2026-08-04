import { describe, expect, it } from 'vitest';
import {
  canNavigateToUploadStep,
  formatBytes,
  formatRemainingTime,
  formatSpeed,
  nextUploadStep,
  previousUploadStep,
  titleFromFileName,
} from './upload-constants';
import {
  hasDetailsErrors,
  validateDetails,
  validatePublishDraft,
  validateSaveDraft,
  validateThumbnailFile,
  validateThumbnailSelection,
  validateVideoFile,
  validateVisibility,
} from './upload-validation';

describe('upload step navigation', () => {
  it('resolves previous and next steps along the ordered flow', () => {
    expect(previousUploadStep('select')).toBeUndefined();
    expect(previousUploadStep('details')).toBe('progress');
    expect(nextUploadStep('visibility')).toBe('publish');
    expect(nextUploadStep('publish')).toBeUndefined();
  });

  it('allows navigation to the active step, earlier steps, or completed later steps', () => {
    expect(
      canNavigateToUploadStep({
        target: 'details',
        activeStep: 'details',
        completedSteps: ['select', 'progress'],
      }),
    ).toBe(true);
    expect(
      canNavigateToUploadStep({
        target: 'select',
        activeStep: 'details',
        completedSteps: ['select', 'progress'],
      }),
    ).toBe(true);
    expect(
      canNavigateToUploadStep({
        target: 'thumbnail',
        activeStep: 'details',
        completedSteps: ['select', 'progress', 'thumbnail'],
      }),
    ).toBe(true);
    expect(
      canNavigateToUploadStep({
        target: 'publish',
        activeStep: 'details',
        completedSteps: ['select', 'progress'],
      }),
    ).toBe(false);
  });
});

describe('upload validation', () => {
  it('rejects missing, unsupported, empty, and oversized video files', () => {
    expect(validateVideoFile(undefined)).toMatch(/select a video/i);
    expect(validateVideoFile({ name: 'clip.txt', size: 10, type: 'text/plain' })).toMatch(
      /unsupported format/i,
    );
    expect(validateVideoFile({ name: 'clip.mp4', size: 0, type: 'video/mp4' })).toMatch(/empty/i);
    expect(
      validateVideoFile({
        name: 'clip.mp4',
        size: 3 * 1024 * 1024 * 1024,
        type: 'video/mp4',
      }),
    ).toMatch(/too large/i);
    expect(validateVideoFile({ name: 'clip.mp4', size: 1_024, type: 'video/mp4' })).toBeUndefined();
    expect(validateVideoFile({ name: 'clip.mov', size: 1_024, type: '' })).toBeUndefined();
  });

  it('validates required details fields and length limits', () => {
    const errors = validateDetails({
      title: '',
      description: '',
      tags: [],
      category: '',
      language: '',
    });
    expect(errors.title).toMatch(/required/i);
    expect(errors.category).toMatch(/required/i);
    expect(errors.language).toMatch(/required/i);
    expect(hasDetailsErrors(errors)).toBe(true);

    expect(
      validateDetails({
        title: 'x'.repeat(101),
        description: 'y'.repeat(5001),
        tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
        category: 'education',
        language: 'en',
      }),
    ).toEqual({
      title: 'Title must be 100 characters or fewer.',
      description: 'Description must be 5,000 characters or fewer.',
      tags: 'You can add up to 20 tags.',
    });

    expect(
      hasDetailsErrors(
        validateDetails({
          title: 'Design systems',
          description: 'A practical tour',
          tags: ['design'],
          category: 'education',
          language: 'en',
        }),
      ),
    ).toBe(false);
  });

  it('validates thumbnails and visibility', () => {
    expect(validateThumbnailSelection({ thumbnailUrl: '' })).toMatch(/thumbnail/i);
    expect(
      validateThumbnailSelection({ thumbnailUrl: 'https://example.com/a.jpg' }),
    ).toBeUndefined();
    expect(validateVisibility({ visibility: '' })).toMatch(/visibility/i);
    expect(validateVisibility({ visibility: 'unlisted' })).toBeUndefined();
    expect(validateThumbnailFile({ name: 'a.gif', size: 10, type: 'image/gif' })).toMatch(
      /unsupported thumbnail/i,
    );
    expect(validateThumbnailFile({ name: 'a.jpg', size: 10, type: 'image/jpeg' })).toBeUndefined();
  });

  it('gates publishing until the upload and draft are complete', () => {
    const ready = {
      uploadId: 'upload-1',
      title: 'Design systems',
      description: 'A practical tour',
      tags: ['design'],
      category: 'education' as const,
      language: 'en' as const,
      thumbnailUrl: 'https://example.com/a.jpg',
      visibility: 'public' as const,
    };
    expect(validatePublishDraft(ready)).toBeUndefined();
    expect(validatePublishDraft({ ...ready, uploadId: undefined })).toMatch(/required fields/i);
    expect(validatePublishDraft({ ...ready, title: '' })).toMatch(/required fields/i);
    expect(validatePublishDraft({ ...ready, thumbnailUrl: '' })).toMatch(/required fields/i);
    expect(validatePublishDraft({ ...ready, visibility: '' })).toMatch(/required fields/i);
  });

  it('gates draft saves on metadata without requiring a durable upload id', () => {
    const ready = {
      title: 'Design systems',
      description: 'A practical tour',
      tags: ['design'],
      category: 'education' as const,
      language: 'en' as const,
      thumbnailUrl: 'https://example.com/a.jpg',
      visibility: 'public' as const,
    };
    expect(validateSaveDraft(ready)).toBeUndefined();
    expect(validateSaveDraft({ ...ready, uploadId: undefined })).toBeUndefined();
    expect(validateSaveDraft({ ...ready, title: '' })).toMatch(/saving this draft/i);
    expect(validateSaveDraft({ ...ready, thumbnailUrl: '' })).toMatch(/saving this draft/i);
  });
});

describe('upload formatting helpers', () => {
  it('formats file names, bytes, speed, and remaining time', () => {
    expect(titleFromFileName('my_cool-video.mp4')).toBe('My Cool Video');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s');
    expect(formatRemainingTime(0.4)).toBe('Less than a second');
    expect(formatRemainingTime(75)).toBe('1m 15s remaining');
  });
});
