/**
 * The thumbnail is deliberately made in the creator's browser from their
 * authenticated draft stream. That keeps an upload private and avoids moving
 * video bytes through another service just to create a preview image.
 */
export const generatedThumbnailMaxDimension = 1280;

/** Choose an early, stable frame rather than the usually-black first frame. */
export function generatedThumbnailCaptureTime(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;

  const lastSafeMoment = Math.max(0, durationSeconds - 0.2);
  if (lastSafeMoment === 0) return 0;

  return Math.min(lastSafeMoment, Math.max(0.2, Math.min(3, durationSeconds * 0.15)));
}

/** Scale a source frame down so generated JPEGs stay comfortably below the upload limit. */
export function generatedThumbnailDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension = generatedThumbnailMaxDimension,
): { width: number; height: number } {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
    throw new Error('The video does not expose frame dimensions.');
  }
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('The video does not expose a usable frame.');
  }

  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export function generatedThumbnailFilename(videoFilename: string): string {
  const stem = videoFilename
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return `${stem || 'video'}-thumbnail.jpg`;
}

function waitForVideoEvent(video: HTMLVideoElement, eventName: 'loadedmetadata' | 'seeked') {
  return new Promise<void>((resolve, reject) => {
    const onSuccess = () => finish(resolve);
    const onFailure = () => finish(() => reject(new Error('The video preview could not be read.')));
    const finish = (callback: () => void) => {
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener('error', onFailure);
      callback();
    };

    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener('error', onFailure, { once: true });
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The video preview image could not be created.'));
      },
      'image/jpeg',
      0.84,
    );
  });
}

/**
 * Capture a private draft-video frame as a small JPEG suitable for the existing
 * authenticated thumbnail upload route. It is called only in the browser.
 */
export async function createGeneratedVideoThumbnail(
  source: string,
  videoFilename: string,
): Promise<File> {
  if (typeof document === 'undefined') {
    throw new Error('Video previews can only be created in a browser.');
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';

  try {
    const metadataLoaded = waitForVideoEvent(video, 'loadedmetadata');
    video.src = source;
    await metadataLoaded;
    const captureTime = generatedThumbnailCaptureTime(video.duration);
    if (captureTime > 0 && Math.abs(video.currentTime - captureTime) > 0.01) {
      video.currentTime = captureTime;
      await waitForVideoEvent(video, 'seeked');
    }

    const { width, height } = generatedThumbnailDimensions(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The video preview image could not be created.');
    context.drawImage(video, 0, 0, width, height);

    const image = await canvasBlob(canvas);
    return new File([image], generatedThumbnailFilename(videoFilename), { type: 'image/jpeg' });
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}
