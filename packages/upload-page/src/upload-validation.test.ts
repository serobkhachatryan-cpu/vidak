import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatRemainingTime,
  formatSpeed,
  titleFromFileName,
} from './upload-constants';
import {
  hasDetailsErrors,
  validateDetails,
  validateThumbnailFile,
  validateThumbnailSelection,
  validateVideoFile,
  validateVisibility,
} from './upload-validation';

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

  it('validates required details fields', () => {
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
