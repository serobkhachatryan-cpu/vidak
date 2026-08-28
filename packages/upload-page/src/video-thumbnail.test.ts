import { describe, expect, it } from 'vitest';
import {
  generatedThumbnailCaptureTime,
  generatedThumbnailDimensions,
  generatedThumbnailFilename,
} from './video-thumbnail';

describe('generated video thumbnails', () => {
  it('chooses a safe early frame instead of the initial frame', () => {
    expect(generatedThumbnailCaptureTime(20)).toBe(3);
    expect(generatedThumbnailCaptureTime(1)).toBeCloseTo(0.2);
    expect(generatedThumbnailCaptureTime(0.1)).toBe(0);
    expect(generatedThumbnailCaptureTime(Number.NaN)).toBe(0);
  });

  it('keeps the source aspect ratio while limiting output size', () => {
    expect(generatedThumbnailDimensions(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(generatedThumbnailDimensions(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it('creates a safe JPEG filename from the uploaded file name', () => {
    expect(generatedThumbnailFilename('My summer clip.mov')).toBe('My-summer-clip-thumbnail.jpg');
    expect(generatedThumbnailFilename('')).toBe('video-thumbnail.jpg');
  });
});
