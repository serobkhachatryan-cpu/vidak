'use client';

import { useEffect, useRef, useState } from 'react';
import { previewFallbackCopy } from './video-space-model';

export type VideoPreviewState = 'loading' | 'ready' | 'processing' | 'unsupported';

export function VideoSpacePreviewFallback({
  title,
  state,
}: {
  title: string;
  state: 'processing' | 'unsupported';
}) {
  const copy = previewFallbackCopy(state);
  return (
    <div
      className="flex aspect-video w-full flex-col items-center justify-center gap-1 bg-muted px-4 text-center"
      role="img"
      aria-label={`${title} ${copy.label}`}
    >
      <p className="font-sans text-sm font-medium text-foreground">{copy.label}</p>
      <p className="font-sans text-xs text-muted-foreground">{copy.description}</p>
    </div>
  );
}

/**
 * Builds a still frame from an accessible video element. The generated image is
 * display-only and is never persisted as a poster upload.
 */
export async function captureVideoPreviewFrame(
  video: HTMLVideoElement,
): Promise<string | undefined> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return undefined;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.drawImage(video, 0, 0, width, height);
  try {
    const url = canvas.toDataURL('image/jpeg', 0.72);
    return url.startsWith('data:image/') ? url : undefined;
  } catch {
    return undefined;
  }
}

export function useCapturedVideoPreview(video: HTMLVideoElement | null): {
  poster: string | undefined;
  state: VideoPreviewState;
  markUnsupported: () => void;
} {
  const [poster, setPoster] = useState<string | undefined>();
  const [state, setState] = useState<VideoPreviewState>('loading');
  const capturedFor = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setPoster(undefined);
    setState(video ? 'loading' : 'processing');
    capturedFor.current = null;
  }, [video]);

  useEffect(() => {
    if (!video) return;
    let cancelled = false;

    const capture = () => {
      if (cancelled || capturedFor.current === video) return;
      void captureVideoPreviewFrame(video).then((next) => {
        if (cancelled) return;
        if (next) {
          capturedFor.current = video;
          setPoster(next);
          setState('ready');
          return;
        }
        setState(video.readyState > 0 ? 'unsupported' : 'processing');
      });
    };

    video.addEventListener('loadeddata', capture);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) capture();
    return () => {
      cancelled = true;
      video.removeEventListener('loadeddata', capture);
    };
  }, [video]);

  return {
    poster,
    state,
    markUnsupported: () => setState('unsupported'),
  };
}
