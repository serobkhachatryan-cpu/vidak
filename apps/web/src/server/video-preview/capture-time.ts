/**
 * Choose useful still-frame timestamps. The first frame of a recording is
 * often black; prefer an early stable scene, then later fallbacks.
 */

const blackLumaThreshold = 18;

/** Same early-scene rule as the upload-page browser thumbnail helper. */
export function previewCaptureTime(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;

  const lastSafeMoment = Math.max(0, durationSeconds - 0.2);
  if (lastSafeMoment === 0) return 0;

  return Math.min(lastSafeMoment, Math.max(0.2, Math.min(3, durationSeconds * 0.15)));
}

/** Ordered candidates: useful scene first, then later non-black fallbacks. */
export function previewCaptureCandidates(durationSeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [1, 2, 3];
  }

  const lastSafe = Math.max(0, durationSeconds - 0.2);
  const primary = previewCaptureTime(durationSeconds);
  const candidates = [
    primary,
    Math.min(lastSafe, durationSeconds * 0.25),
    Math.min(lastSafe, durationSeconds * 0.5),
    Math.min(lastSafe, 5),
    Math.min(lastSafe, 1),
  ];

  const unique: number[] = [];
  for (const time of candidates) {
    if (!Number.isFinite(time) || time < 0) continue;
    const rounded = Math.round(time * 100) / 100;
    if (!unique.some((existing) => Math.abs(existing - rounded) < 0.05)) {
      unique.push(rounded);
    }
  }
  return unique.length > 0 ? unique : [0];
}

/** True when a packed RGB24 frame is too dark to use as a poster. */
export function isMostlyBlackFrame(
  pixels: Uint8Array,
  width: number,
  height: number,
  threshold = blackLumaThreshold,
): boolean {
  const expected = width * height * 3;
  if (width <= 0 || height <= 0 || pixels.byteLength < expected) return true;

  let lumaSum = 0;
  for (let index = 0; index < expected; index += 3) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    lumaSum += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  return lumaSum / (width * height) < threshold;
}

export function ownedVideoPreviewPath(videoId: string): string {
  return `/api/videos/owned/${encodeURIComponent(videoId)}/preview`;
}

export function evaultVideoPreviewPath(streamId: string): string {
  return `/api/evault/videos/${encodeURIComponent(streamId)}/preview`;
}
