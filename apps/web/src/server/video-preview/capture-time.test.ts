import { describe, expect, it } from 'vitest';
import {
  evaultVideoPreviewPath,
  isMostlyBlackFrame,
  ownedVideoPreviewPath,
  previewCaptureCandidates,
  previewCaptureTime,
} from './capture-time';

describe('preview capture time', () => {
  it('uses a non-black useful timestamp instead of the opening frame', () => {
    expect(previewCaptureTime(20)).toBe(3);
    expect(previewCaptureTime(1)).toBeCloseTo(0.2);
    expect(previewCaptureTime(0.1)).toBe(0);
    expect(previewCaptureCandidates(20)[0]).toBe(3);
    expect(previewCaptureCandidates(20)[0]).not.toBe(0);
    expect(previewCaptureCandidates(20)).toContain(5);
  });

  it('treats a dark RGB frame as unusable', () => {
    const black = new Uint8Array(2 * 2 * 3);
    expect(isMostlyBlackFrame(black, 2, 2)).toBe(true);
    const bright = new Uint8Array([200, 180, 160, 210, 190, 170, 190, 200, 180, 220, 210, 200]);
    expect(isMostlyBlackFrame(bright, 2, 2)).toBe(false);
  });

  it('keeps preview URLs on the existing authorized API trees', () => {
    expect(ownedVideoPreviewPath('vid-1')).toBe('/api/videos/owned/vid-1/preview');
    expect(evaultVideoPreviewPath('stream/1')).toBe('/api/evault/videos/stream%2F1/preview');
  });
});
