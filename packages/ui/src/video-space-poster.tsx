'use client';

import { isRenderableThumbnailUrl } from '@w3ds/types';
import { useEffect, useRef, useState } from 'react';
import { fetchPreviewWithTimeout } from './preview-fetch';
import { enqueuePreviewLoad } from './preview-load-queue';
import { Badge } from './primitives';

export type VideoSpacePosterState = 'ready' | 'processing' | 'unavailable' | 'restricted';

export interface VideoSpacePosterProps {
  title: string;
  posterUrl?: string;
  fallbackPosterUrl?: string;
  state?: VideoSpacePosterState;
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
  /** When true, preview fetches wait until the card is near the viewport. */
  loadWhenVisible?: boolean;
}

export function shouldRetryPreviewResponse(status: number): boolean {
  return status === 202 || status === 422 || status >= 500;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function VideoSpacePoster({
  title,
  posterUrl,
  fallbackPosterUrl,
  state = 'processing',
  durationSeconds,
  visibilityLabel,
  locked = false,
  loadWhenVisible = false,
}: VideoSpacePosterProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!loadWhenVisible);
  const [source, setSource] = useState<string | undefined>(() =>
    state === 'ready' && posterUrl && isRenderableThumbnailUrl(posterUrl) ? posterUrl : undefined,
  );
  const [failed, setFailed] = useState(state === 'unavailable');
  const [usedFallback, setUsedFallback] = useState(false);

  useEffect(() => {
    if (!loadWhenVisible || visible) return;
    const node = frameRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true);
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadWhenVisible, visible]);

  useEffect(() => {
    setFailed(state === 'unavailable');
    setUsedFallback(false);
    if (state === 'ready' && posterUrl && isRenderableThumbnailUrl(posterUrl)) {
      setSource(posterUrl);
      return;
    }
    setSource(undefined);
    if (!visible) return;
    if (state !== 'processing' || !posterUrl || !isRenderableThumbnailUrl(posterUrl)) return;

    let cancelled = false;
    let activeRequest: AbortController | undefined;
    const poll = async () => {
      const request = new AbortController();
      activeRequest = request;
      try {
        const response = await fetchPreviewWithTimeout(posterUrl, { signal: request.signal });
        if (cancelled) return;
        const type = response.headers.get('content-type') ?? '';
        if (response.ok && type.startsWith('image/')) {
          setSource(posterUrl);
          return;
        }
        if (shouldRetryPreviewResponse(response.status)) {
          window.setTimeout(
            () => {
              if (!cancelled) void enqueuePreviewLoad(poll);
            },
            response.status === 202 ? 2000 : 5000,
          );
          return;
        }
        if (response.status === 404) {
          if (fallbackPosterUrl && fallbackPosterUrl !== posterUrl) {
            setUsedFallback(true);
            setSource(fallbackPosterUrl);
            return;
          }
          setFailed(true);
          return;
        }
        if (fallbackPosterUrl && fallbackPosterUrl !== posterUrl) {
          setUsedFallback(true);
          setSource(fallbackPosterUrl);
          return;
        }
        setFailed(true);
      } catch {
        if (cancelled) return;
        window.setTimeout(() => {
          if (!cancelled) void enqueuePreviewLoad(poll);
        }, 5000);
      } finally {
        if (activeRequest === request) activeRequest = undefined;
      }
    };
    const cancelQueue = enqueuePreviewLoad(poll);
    return () => {
      cancelled = true;
      activeRequest?.abort();
      cancelQueue();
    };
  }, [fallbackPosterUrl, posterUrl, state, visible]);

  const showImage = Boolean(source) && !failed;
  const showProcessing = !showImage && !failed && state === 'processing';
  const showRestricted = !showImage && state === 'restricted';

  return (
    <div ref={frameRef} className="relative overflow-hidden">
      {showImage && source ? (
        <img
          src={source}
          alt=""
          loading="lazy"
          className="aspect-video w-full object-cover"
          onError={() => {
            if (!usedFallback && fallbackPosterUrl && fallbackPosterUrl !== source) {
              setUsedFallback(true);
              setSource(fallbackPosterUrl);
              return;
            }
            setFailed(true);
          }}
        />
      ) : showProcessing ? (
        <VideoSpaceProcessingPoster
          title={title}
          {...(durationSeconds !== undefined ? { durationSeconds } : {})}
          {...(visibilityLabel ? { visibilityLabel } : {})}
          locked={locked}
        />
      ) : showRestricted ? (
        <VideoSpaceRestrictedPoster
          title={title}
          {...(durationSeconds !== undefined ? { durationSeconds } : {})}
          {...(visibilityLabel ? { visibilityLabel } : {})}
          locked={locked}
        />
      ) : (
        <VideoSpaceUnavailablePoster
          title={title}
          {...(durationSeconds !== undefined ? { durationSeconds } : {})}
          {...(visibilityLabel ? { visibilityLabel } : {})}
          locked={locked}
        />
      )}
      {showImage ? (
        <VideoSpacePosterBadges
          {...(durationSeconds !== undefined ? { durationSeconds } : {})}
          {...(visibilityLabel ? { visibilityLabel } : {})}
          locked={locked}
        />
      ) : null}
    </div>
  );
}

export function VideoSpaceProcessingPoster({
  title,
  durationSeconds,
  visibilityLabel,
  locked = false,
}: {
  title: string;
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
}) {
  return (
    <div
      className="relative flex aspect-video w-full flex-col items-center justify-center gap-2 border border-border/60 bg-muted/70 px-4 text-center"
      role="status"
      aria-label={`${title} Preparing preview`}
    >
      <VideoIcon />
      <p className="font-sans text-[11px] text-muted-foreground">Preparing preview</p>
      <VideoSpacePosterBadges
        {...(durationSeconds !== undefined ? { durationSeconds } : {})}
        {...(visibilityLabel ? { visibilityLabel } : {})}
        locked={locked}
      />
    </div>
  );
}

export function VideoSpaceUnavailablePoster({
  title,
  durationSeconds,
  visibilityLabel,
  locked = false,
}: {
  title: string;
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
}) {
  return (
    <div
      className="relative flex aspect-video w-full flex-col items-center justify-center gap-2 border border-border/60 bg-muted/70 px-4 text-center"
      role="img"
      aria-label={`${title} Preview unavailable`}
    >
      <VideoIcon />
      <p className="font-sans text-[11px] text-muted-foreground">Preview unavailable</p>
      <VideoSpacePosterBadges
        {...(durationSeconds !== undefined ? { durationSeconds } : {})}
        {...(visibilityLabel ? { visibilityLabel } : {})}
        locked={locked}
      />
    </div>
  );
}

function VideoSpaceRestrictedPoster({
  title,
  durationSeconds,
  visibilityLabel,
  locked = false,
}: {
  title: string;
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
}) {
  return (
    <div
      className="relative flex aspect-video w-full flex-col items-center justify-center gap-2 border border-border/60 bg-muted/70 px-4 text-center"
      role="img"
      aria-label={`${title} Shared video`}
    >
      <VideoIcon />
      <p className="font-sans text-[11px] text-muted-foreground">Shared video</p>
      <p className="font-sans text-[11px] text-muted-foreground">
        Preview stays private until source permission is verified
      </p>
      <VideoSpacePosterBadges
        {...(durationSeconds !== undefined ? { durationSeconds } : {})}
        {...(visibilityLabel ? { visibilityLabel } : {})}
        locked={locked}
      />
    </div>
  );
}

function VideoSpacePosterBadges({
  durationSeconds,
  visibilityLabel,
  locked,
}: {
  durationSeconds?: number;
  visibilityLabel?: string;
  locked?: boolean;
}) {
  return (
    <>
      {visibilityLabel ? (
        <Badge
          tone="muted"
          className="absolute left-2 top-2 bg-black/75 text-white"
          aria-label={locked ? `${visibilityLabel}, locked` : visibilityLabel}
        >
          {locked ? `🔒 ${visibilityLabel}` : visibilityLabel}
        </Badge>
      ) : null}
      {durationSeconds !== undefined ? (
        <Badge
          tone="muted"
          className="absolute bottom-2 right-2 bg-black/80 text-white"
          aria-label={`Duration ${formatDuration(durationSeconds)}`}
        >
          {formatDuration(durationSeconds)}
        </Badge>
      ) : null}
    </>
  );
}

function VideoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-7 w-7 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <rect x="3" y="6" width="14" height="12" rx="2" />
      <path d="M17 10.5 21 8v8l-4-2.5" />
    </svg>
  );
}
